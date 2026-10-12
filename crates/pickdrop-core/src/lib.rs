pub mod protocol;
use anyhow::{bail, ensure, Context, Result};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::SigningKey;
use futures_util::{stream, StreamExt};
use protocol::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{broadcast, Mutex, Semaphore},
};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub struct Core(Arc<Inner>);
struct Inner {
    dir: PathBuf,
    key: SigningKey,
    data: Mutex<Data>,
    events: broadcast::Sender<Value>,
    http: reqwest::Client,
    file_http: reqwest::Client,
    endpoint: std::sync::RwLock<Value>,
    active: AtomicBool,
    syncing: AtomicBool,
    network: Semaphore,
    transfers: Mutex<HashMap<String, CancellationToken>>,
    mdns: Option<mdns_sd::ServiceDaemon>,
    discovered: Mutex<BTreeMap<String, Value>>,
}
struct Data {
    device: Value,
    groups: BTreeMap<String, Group>,
    active: Option<String>,
}
struct Group {
    replica: Replica,
    peers: BTreeMap<String, String>,
    remote_known: HashMap<String, HashSet<String>>,
    invites: HashMap<String, i64>,
    tickets: HashMap<String, Value>,
    hidden: bool,
    seen: HashMap<String, i64>,
    presence_revision: u64,
    online: HashSet<String>,
    retry: HashMap<String, (u32, i64)>,
}
impl Core {
    /// Non-destructive desktop migration. Destination must be a new directory and the old app must be closed.
    /// Mobile secrets live in SecureStore and must be exported explicitly or the device must rejoin.
    pub async fn import_legacy_desktop(source: PathBuf, destination: PathBuf) -> Result<Value> {
        ensure!(
            source.canonicalize()? != destination.canonicalize().unwrap_or(destination.clone()),
            "Source and destination must differ"
        );
        if destination.exists() {
            ensure!(
                tokio::fs::read_dir(&destination)
                    .await?
                    .next_entry()
                    .await?
                    .is_none(),
                "Migration destination must be empty"
            );
        }
        let groups: Value =
            serde_json::from_slice(&tokio::fs::read(source.join("groups.json")).await?)?;
        let identity: Value =
            serde_json::from_slice(&tokio::fs::read(source.join("peer-identity.json")).await?)?;
        let key = signing(s(&identity, "privateKey"))?;
        let device = groups["device"].clone();
        ensure!(
            uuid::Uuid::parse_str(s(&device, "id")).is_ok(),
            "Invalid legacy device"
        );
        let mut snapshots = Vec::new();
        let mut skipped = 0;
        for group in groups["groups"]
            .as_array()
            .context("Invalid legacy groups")?
        {
            if s(group, "mode") != "peer" {
                skipped += 1;
                continue;
            }
            let id = s(group, "id");
            ensure!(uuid::Uuid::parse_str(id).is_ok(), "Invalid group ID");
            let saved: Value = serde_json::from_slice(
                &tokio::fs::read(source.join("groups").join(id).join("peer.json")).await?,
            )?;
            let replica = Replica::new(
                saved["genesis"].clone(),
                saved["events"]
                    .as_array()
                    .cloned()
                    .context("Missing events")?,
            )?;
            ensure!(
                s(&replica.genesis, "groupId") == id,
                "Legacy group ID mismatch"
            );
            let mut value = replica.snapshot();
            value["peers"] = saved["peers"].clone();
            value["hidden"] = json!(!replica.member(
                s(&device, "id"),
                &hex::encode(key.verifying_key().to_bytes())
            ));
            snapshots.push((id.to_string(), value, replica.state["messages"].clone()));
        }
        // Validate all snapshots before writing any migration artifact.
        let stage = destination.with_extension(format!("migration-{}", random(8)));
        tokio::fs::create_dir_all(stage.join("files")).await?;
        let result=async {
            atomic(&stage.join("identity.json"),&json!({"privateKey":hex::encode(key.to_bytes()),"device":device})).await?;
            let mut copied=0usize;
            for(id,value,messages)in &snapshots{
                atomic(&stage.join(format!("group_{id}.json")),value).await?;
                for message in messages.as_array().unwrap(){if s(message,"type")!="file"{continue;}
                    let file=source.join("groups").join(id).join("files").join(s(message,"id")).join(s(message,"fileName"));
                    if tokio::fs::symlink_metadata(&file).await.is_ok_and(|m|m.is_file()) {
                        let target=stage.join("files").join(s(message,"sha256"));if target.exists(){continue;}
                        let mut input=tokio::fs::File::open(file).await?;let mut output=tokio::fs::File::create(&target).await?;let mut hash=Sha256::new();let mut bytes=0u64;let mut buffer=vec![0;256*1024];loop{let n=input.read(&mut buffer).await?;if n==0{break;}hash.update(&buffer[..n]);bytes+=n as u64;output.write_all(&buffer[..n]).await?;}
                        if bytes!=message["size"].as_u64().unwrap()||hex::encode(hash.finalize())!=s(message,"sha256"){tokio::fs::remove_file(target).await?;}else{output.sync_all().await?;copied+=1;}
                    }
                }
            }
            if destination.exists(){tokio::fs::remove_dir(&destination).await?;}tokio::fs::rename(&stage,&destination).await?;
            Ok::<_,anyhow::Error>(json!({"groups":snapshots.len(),"files":copied,"skippedLegacyHostedGroups":skipped,"destination":destination}))
        }.await;
        if result.is_err() {
            let _ = tokio::fs::remove_dir_all(stage).await;
        }
        result
    }
    pub async fn open(dir: PathBuf, kind: &str) -> Result<Self> {
        tokio::fs::create_dir_all(dir.join("files")).await?;
        let identity = dir.join("identity.json");
        let (key, device) = if identity.exists() {
            let v: Value = serde_json::from_slice(&tokio::fs::read(&identity).await?)?;
            (signing(s(&v, "privateKey"))?, v["device"].clone())
        } else {
            let key = signing(&random(32))?;
            let device = json!({"id":uuid::Uuid::new_v4(),"name":if kind=="mobile"{"手机"}else{"电脑"},"kind":kind});
            atomic(
                &identity,
                &json!({"privateKey":hex::encode(key.to_bytes()),"device":device}),
            )
            .await?;
            (key, device)
        };
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await?;
        let port = listener.local_addr()?.port();
        let ip = local_ip_address::local_ip().unwrap_or("127.0.0.1".parse().unwrap());
        let endpoint =
            json!({"baseUrl":format!("http://{ip}:{port}"),"port":port,"deviceId":device["id"]});
        let mut groups = BTreeMap::new();
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("group_") && name.ends_with(".json") {
                let saved: Value = serde_json::from_slice(&tokio::fs::read(entry.path()).await?)?;
                let replica = Replica::new(
                    saved["genesis"].clone(),
                    saved["events"].as_array().cloned().unwrap_or_default(),
                )
                .with_context(|| format!("Invalid persisted group {name}"))?;
                let peers = saved["peers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| {
                        origin(s(v, "baseUrl"))
                            .ok()
                            .map(|url| (url, s(v, "deviceId").into()))
                    })
                    .collect();
                groups.insert(
                    s(&replica.genesis, "groupId").into(),
                    Group {
                        replica,
                        peers,
                        remote_known: HashMap::new(),
                        invites: HashMap::new(),
                        tickets: HashMap::new(),
                        hidden: saved["hidden"].as_bool().unwrap_or(false),
                        seen: HashMap::new(),
                        presence_revision: 0,
                        online: HashSet::new(),
                        retry: HashMap::new(),
                    },
                );
            }
        }
        let active = if let Ok(bytes) = tokio::fs::read(dir.join("settings.json")).await {
            serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v["activeGroupId"].as_str().map(str::to_owned))
                .filter(|id| groups.contains_key(id))
        } else {
            None
        };
        let (events, _) = broadcast::channel(128);
        let core = Self(Arc::new(Inner {
            dir,
            key,
            data: Mutex::new(Data {
                device,
                groups,
                active,
            }),
            events,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            file_http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoint: std::sync::RwLock::new(endpoint),
            active: AtomicBool::new(true),
            syncing: AtomicBool::new(false),
            network: Semaphore::new(4),
            transfers: Mutex::new(HashMap::new()),
            mdns: mdns_sd::ServiceDaemon::new().ok(),
            discovered: Mutex::new(BTreeMap::new()),
        }));
        let router = Router::new()
            .route("/api/peer/info", get(info))
            .route("/api/discovery/groups", get(discovery))
            .route("/api/peer/sync", post(sync_handler))
            .route("/api/peer/pair/request", post(pair_request))
            .route("/api/peer/pair/status/{id}", get(pair_status))
            .route("/api/peer/files/{id}", get(file_handler))
            .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
            .with_state(core.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let weak = Arc::downgrade(&core.0);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(4));
            loop {
                interval.tick().await;
                let Some(inner) = weak.upgrade() else { break };
                let core = Core(inner);
                if core.0.active.load(Ordering::Relaxed) {
                    core.refresh_network().await;
                    core.sync_all().await;
                }
            }
        });
        core.start_discovery();
        {
            let data = core.0.data.lock().await;
            for (id, g) in &data.groups {
                core.announce(id, g);
            }
        }
        Ok(core)
    }
    fn endpoint(&self) -> Value {
        self.0.endpoint.read().unwrap().clone()
    }
    async fn refresh_network(&self) {
        let Ok(ip) = local_ip_address::local_ip() else {
            return;
        };
        let current = self.endpoint();
        let port = current["port"].as_u64().unwrap();
        let base = if ip.is_ipv6() {
            format!("http://[{ip}]:{port}")
        } else {
            format!("http://{ip}:{port}")
        };
        if s(&current, "baseUrl") != base {
            self.0.endpoint.write().unwrap()["baseUrl"] = base.into();
            let mut data = self.0.data.lock().await;
            for (id, g) in &mut data.groups {
                g.retry.clear();
                self.announce(id, g);
            }
            self.emit(json!({"type":"endpoint","endpoint":self.endpoint()}));
        }
    }
    fn announce(&self, id: &str, g: &Group) {
        if let Some(daemon) = &self.0.mdns {
            let instance = format!("pickdrop-{}-{}", &id[..8], s(&self.endpoint(), "deviceId"));
            let fullname = format!("{instance}._pickdrop._tcp.local.");
            if g.hidden || g.replica.state["dissolved"].as_bool().unwrap_or(false) {
                let _ = daemon.unregister(&fullname);
                return;
            }
            let mut props = HashMap::new();
            for (key, value) in [
                ("protocol", "pickdrop"),
                ("version", "1"),
                ("groupId", id),
                ("hostDeviceId", s(&self.endpoint(), "deviceId")),
                ("name", s(&g.replica.state, "name")),
                ("peerProtocol", PROTOCOL),
            ] {
                props.insert(key.to_string(), value.to_string());
            }
            let ip = reqwest::Url::parse(s(&self.endpoint(), "baseUrl"))
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_default();
            if let Ok(info) = mdns_sd::ServiceInfo::new(
                "_pickdrop._tcp.local.",
                &instance,
                &format!("pickdrop-{}.local.", s(&self.endpoint(), "deviceId")),
                ip.as_str(),
                self.endpoint()["port"].as_u64().unwrap() as u16,
                props,
            ) {
                let _ = daemon.register(info);
            }
        }
    }
    fn start_discovery(&self) {
        let Some(daemon) = &self.0.mdns else { return };
        let Ok(receiver) = daemon.browse("_pickdrop._tcp.local.") else {
            return;
        };
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let Some(inner) = weak.upgrade() else { break };
                let core = Core(inner);
                while let Ok(event) = receiver.try_recv() {
                    if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
                        let props = info.get_properties();
                        let group = props.get_property_val_str("groupId").unwrap_or("");
                        let device = props.get_property_val_str("hostDeviceId").unwrap_or("");
                        if device == s(&core.endpoint(), "deviceId")
                            || uuid::Uuid::parse_str(group).is_err()
                            || uuid::Uuid::parse_str(device).is_err()
                            || props.get_property_val_str("peerProtocol") != Some(PROTOCOL)
                        {
                            continue;
                        }
                        for addr in info.get_addresses() {
                            let base = format!("http://{}:{}", addr, info.get_port());
                            if origin(&base).is_err() {
                                continue;
                            }
                            let value = json!({"groupId":group,"hostDeviceId":device,"name":props.get_property_val_str("name").unwrap_or("传输群"),"baseUrl":base,"peerProtocol":PROTOCOL,"seenAt":chrono::Utc::now().timestamp_millis()});
                            let mut records = core.0.discovered.lock().await;
                            if records.len() < 1024 {
                                records.insert(format!("{group}:{base}"), value);
                            }
                            drop(records);
                            let mut data = core.0.data.lock().await;
                            if let Some(g) = data.groups.get_mut(group) {
                                if g.peers.len() < 64 && !g.peers.contains_key(&base) {
                                    g.peers.insert(base, device.into());
                                }
                            }
                        }
                        core.emit(json!({"type":"discovery"}));
                    }
                }
            }
        });
    }
    fn kick_sync(&self) {
        let core = self.clone();
        tokio::spawn(async move {
            if core.0.active.load(Ordering::Relaxed) {
                core.sync_all().await;
            }
        });
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.0.events.subscribe()
    }
    fn emit(&self, v: Value) {
        let _ = self.0.events.send(v);
    }
    fn group_list(data: &Data, endpoint: &Value) -> Vec<Value> {
        data.groups.iter().filter(|(_,g)|!g.hidden).map(|(id,g)|json!({"id":id,"name":g.replica.state["name"],"animalId":g.replica.state["animalId"],"creatorDeviceId":g.replica.genesis["creatorDeviceId"],"mode":"peer","baseUrl":endpoint["baseUrl"]})).collect()
    }
    fn state(&self, g: &Group, before: Option<usize>, limit: usize) -> Value {
        let mut state = json!({"id":g.replica.state["id"],"name":g.replica.state["name"],"animalId":g.replica.state["animalId"],"dissolved":g.replica.state["dissolved"]});
        let all = g.replica.state["messages"].as_array().unwrap();
        let total = all.len();
        let end = before
            .map(|n| n.saturating_sub(1).min(total))
            .unwrap_or(total);
        let start = end.saturating_sub(limit.clamp(1, 500));
        let messages: Vec<_> = all[start..end]
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let mut m = m.clone();
                m["sequence"] = json!(start + i + 1);
                m
            })
            .collect();
        state["messages"] = json!(messages);
        state["devices"] = json!(g.replica.state["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let mut m = m.clone();
                m["online"] = json!(
                    (m["id"] == self.endpoint()["deviceId"]
                        && self.0.active.load(Ordering::Relaxed))
                        || g.seen
                            .get(s(&m, "id"))
                            .is_some_and(
                                |seen| chrono::Utc::now().timestamp_millis() - seen < 15000
                            )
                );
                m
            })
            .collect::<Vec<_>>());
        state.as_object_mut().unwrap().remove("members");
        state["history"] = json!({"hasMore":start>0,"before":if start<end{Some((start+1).to_string())}else{None},"latest":total.to_string(),"total":total});
        state["revision"] = json!(g.replica.revision);
        state["presenceRevision"] = json!(g.presence_revision);
        state["membershipRevoked"] = json!(!g.replica.member(
            s(&self.endpoint(), "deviceId"),
            &hex::encode(self.0.key.verifying_key().to_bytes())
        ));
        state
    }
    async fn persist(&self, id: &str, g: &Group) -> Result<()> {
        let mut value = g.replica.snapshot();
        value["hidden"] = json!(g.hidden);
        value["peers"] = json!(g
            .peers
            .iter()
            .map(|(url, id)| json!({"baseUrl":url,"deviceId":id}))
            .collect::<Vec<_>>());
        atomic(&self.0.dir.join(format!("group_{id}.json")), &value).await
    }
    async fn changed(&self, id: &str, data: &mut Data) -> Result<()> {
        let g = &data.groups[id];
        if let Err(error) = self.persist(id, g).await {
            // Restore the last committed snapshot on a failed atomic write; no uncommitted state is emitted.
            let path = self.0.dir.join(format!("group_{id}.json"));
            if let Ok(bytes) = tokio::fs::read(path).await {
                if let Ok(saved) = serde_json::from_slice::<Value>(&bytes) {
                    if let Ok(mut replica) = Replica::new(
                        saved["genesis"].clone(),
                        saved["events"].as_array().cloned().unwrap_or_default(),
                    ) {
                        replica.revision = g.replica.revision.saturating_sub(1);
                        let g = data.groups.get_mut(id).unwrap();
                        g.replica = replica;
                        g.hidden = saved["hidden"].as_bool().unwrap_or(false);
                    }
                }
            } else {
                data.groups.remove(id);
            }
            return Err(error);
        }
        let g = &data.groups[id];
        self.announce(id, g);
        self.emit(json!({"type":"state","groupId":id,"state":self.state(g,None,60)}));
        self.emit(json!({"type":"groups","groups":Self::group_list(data,&self.endpoint())}));
        Ok(())
    }
    pub async fn dispatch(&self, method: &str, p: Value) -> Result<Value> {
        if method == "discover_groups" {
            return Ok(json!(self
                .0
                .discovered
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>()));
        }
        if method == "cancel_transfer" {
            let id = s(&p, "transferId");
            if let Some(token) = self.0.transfers.lock().await.get(id) {
                token.cancel();
                self.emit(json!({"type":"transfer","id":id,"status":"cancelled"}));
                return Ok(json!({"ok":true}));
            }
            return Ok(json!({"ok":false}));
        }
        if method == "send_file" || method == "receive_file" {
            let transfer_id = if !s(&p, "transferId").is_empty() {
                s(&p, "transferId").to_string()
            } else if method == "receive_file" {
                s(&p, "id").to_string()
            } else {
                uuid::Uuid::new_v4().to_string()
            };
            ensure!(transfer_id.len() <= 128, "Invalid transfer ID");
            let token = CancellationToken::new();
            {
                let mut transfers = self.0.transfers.lock().await;
                ensure!(
                    !transfers.contains_key(&transfer_id),
                    "Transfer already active"
                );
                transfers.insert(transfer_id.clone(), token.clone());
            }
            let result = if method == "send_file" {
                self.send_file(
                    s(&p, "groupId"),
                    PathBuf::from(s(&p, "path")),
                    &transfer_id,
                    &token,
                )
                .await
            } else {
                self.receive_file(s(&p, "groupId"), s(&p, "id"), &transfer_id, &token)
                    .await
            };
            self.0.transfers.lock().await.remove(&transfer_id);
            if let Err(error) = &result {
                self.emit(json!({"type":"transfer","id":transfer_id,"status":if token.is_cancelled(){"cancelled"}else{"failed"},"error":error.to_string()}));
            }
            return result;
        }
        if method == "join_group" {
            let address = origin(s(&p, "address"))?;
            let data = self.0.data.lock().await;
            let proof = sign(
                json!({"protocol":PROTOCOL,"operation":"join","code":s(&p,"code"),"device":data.device,"publicKey":hex::encode(self.0.key.verifying_key().to_bytes())}),
                &self.0.key,
            );
            drop(data);
            let mut ticket = self
                .request(&address, "/api/peer/pair/request", proof)
                .await?;
            ensure!(
                ticket["groupId"].is_string()
                    && s(&ticket, "requestId").len() == 32
                    && s(&ticket, "pollToken").len() == 64,
                "Invalid join ticket"
            );
            ticket["baseUrl"] = address.into();
            return Ok(ticket);
        }
        if method == "check_join" {
            return self.check_join(&p["ticket"]).await;
        }
        if method == "storage_stats" {
            let (files, bytes) = self.cache_stats().await?;
            return Ok(json!({"files":files,"bytes":bytes}));
        }
        if method == "clear_cache" {
            let mut e = tokio::fs::read_dir(self.0.dir.join("files")).await?;
            while let Some(f) = e.next_entry().await? {
                if f.file_type().await?.is_file() {
                    tokio::fs::remove_file(f.path()).await?
                }
            }
            return Ok(json!({"ok":true}));
        }
        if method == "set_active" {
            let active = p["active"].as_bool().unwrap_or(true);
            let previous = self.0.active.swap(active, Ordering::AcqRel);
            if previous != active {
                let mut data = self.0.data.lock().await;
                for (id, g) in &mut data.groups {
                    g.presence_revision += 1;
                    self.emit(json!({"type":"state","groupId":id,"state":self.state(g,None,60)}));
                }
                drop(data);
                if active {
                    self.kick_sync();
                }
            }
            return Ok(json!({"ok":true}));
        }
        let mut data = self.0.data.lock().await;
        let id = s(&p, "groupId").to_string();
        let device = data.device.clone();
        match method {
            "bootstrap" => Ok(
                json!({"device":device,"groups":Self::group_list(&data,&self.endpoint()),"activeGroupId":data.active,"endpoint":self.endpoint()}),
            ),
            "list_groups" => Ok(json!(Self::group_list(&data, &self.endpoint()))),
            "create_group" => {
                let name = s(&p, "name").trim();
                ensure!(!name.is_empty(), "群名不能为空");
                let id = uuid::Uuid::new_v4().to_string();
                let animal = if ANIMALS.contains(&s(&p, "animalId")) {
                    s(&p, "animalId")
                } else {
                    ANIMALS[data.groups.len() % 10]
                };
                let public = hex::encode(self.0.key.verifying_key().to_bytes());
                let mut creator = device.clone();
                creator["publicKey"] = public.clone().into();
                let genesis = sign(
                    json!({"protocol":PROTOCOL,"groupId":id,"name":name.chars().take(40).collect::<String>(),"animalId":animal,"creatorDeviceId":device["id"],"creatorPublicKey":public,"creator":creator}),
                    &self.0.key,
                );
                let replica = Replica::new(genesis, vec![])?;
                data.groups.insert(
                    id.clone(),
                    Group {
                        replica,
                        peers: BTreeMap::new(),
                        remote_known: HashMap::new(),
                        invites: HashMap::new(),
                        tickets: HashMap::new(),
                        hidden: false,
                        seen: HashMap::new(),
                        presence_revision: 0,
                        online: HashSet::new(),
                        retry: HashMap::new(),
                    },
                );
                data.active = Some(id.clone());
                self.changed(&id, &mut data).await?;
                atomic(
                    &self.0.dir.join("settings.json"),
                    &json!({"activeGroupId":id}),
                )
                .await?;
                Ok(Self::group_list(&data, &self.endpoint())
                    .into_iter()
                    .find(|g| s(g, "id") == id)
                    .unwrap())
            }
            "select_group" => {
                let id = s(&p, "id");
                ensure!(data.groups.contains_key(id), "群不存在");
                data.active = Some(id.into());
                atomic(
                    &self.0.dir.join("settings.json"),
                    &json!({"activeGroupId":id}),
                )
                .await?;
                Ok(self.state(&data.groups[id], None, 100))
            }
            "rename_device" => {
                let name = s(&p, "name").trim();
                ensure!(
                    !name.is_empty() && name.chars().count() <= 80,
                    "Invalid device name"
                );
                data.device["name"] = name.into();
                atomic(
                    &self.0.dir.join("identity.json"),
                    &json!({"privateKey":hex::encode(self.0.key.to_bytes()),"device":data.device}),
                )
                .await?;
                let new_device = data.device.clone();
                let ids: Vec<_> = data.groups.keys().cloned().collect();
                for id in ids {
                    let g = data.groups.get_mut(&id).unwrap();
                    if let Some(mut m) = g.replica.state["members"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|m| m["id"] == device["id"])
                        .cloned()
                    {
                        m["name"] = name.into();
                        g.replica
                            .append("member.add", m, &new_device, &self.0.key)?;
                        self.changed(&id, &mut data).await?
                    }
                }
                Ok(data.device.clone())
            }
            _ => {
                let g = data
                    .groups
                    .get_mut(&id)
                    .ok_or_else(|| anyhow::anyhow!("群不存在"))?;
                match method {
                    "get_state" => Ok(self.state(
                        g,
                        p["before"]
                            .as_str()
                            .and_then(|s| s.parse().ok())
                            .or(p["before"].as_u64().map(|n| n as usize)),
                        p["limit"].as_u64().unwrap_or(100) as usize,
                    )),
                    "send_text" => {
                        let m = json!({"id":uuid::Uuid::new_v4(),"type":"text","text":s(&p,"text"),"senderId":device["id"],"senderName":device["name"],"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
                        g.replica
                            .append("message", m.clone(), &device, &self.0.key)?;
                        self.changed(&id, &mut data).await?;
                        self.kick_sync();
                        Ok(m)
                    }
                    "create_invite" => {
                        ensure!(
                            g.replica.member(
                                s(&device, "id"),
                                &hex::encode(self.0.key.verifying_key().to_bytes())
                            ) && !g.replica.state["dissolved"].as_bool().unwrap_or(false),
                            "Not an active member"
                        );
                        let now = chrono::Utc::now().timestamp_millis();
                        g.invites.retain(|_, expires| *expires > now);
                        ensure!(g.invites.len() < 20, "Too many invitations");
                        let code = loop {
                            let code = format!("{:06}", rand::random::<u32>() % 1000000);
                            if !g.invites.contains_key(&code) {
                                break code;
                            }
                        };
                        let expires = now + 300000;
                        g.invites.insert(code.clone(), expires);
                        Ok(
                            json!({"code":code,"expiresAt":expires,"baseUrl":self.endpoint()["baseUrl"],"groupId":id,"link":format!("{}/#invite={code}&group={id}&protocol=peer",s(&self.endpoint(),"baseUrl"))}),
                        )
                    }
                    "list_join_requests" => Ok(json!(g
                        .tickets
                        .values()
                        .filter(|t| s(t, "status") == "pending"
                            && t["expiresAt"].as_i64().unwrap_or(0)
                                > chrono::Utc::now().timestamp_millis())
                        .map(|t| {
                            let mut t = t.clone();
                            t.as_object_mut().unwrap().remove("pollToken");
                            t["id"] = t["requestId"].clone();
                            t
                        })
                        .collect::<Vec<_>>())),
                    "respond_join" => {
                        let request = s(&p, "id");
                        let ticket = g.tickets.get(request).context("加入申请不存在")?.clone();
                        ensure!(
                            s(&ticket, "status") == "pending"
                                && ticket["expiresAt"].as_i64().unwrap_or(0)
                                    > chrono::Utc::now().timestamp_millis(),
                            "申请已过期或已处理"
                        );
                        let allow = p["allow"].as_bool().context("Invalid decision")?;
                        if allow {
                            let mut member = ticket["device"].clone();
                            member["publicKey"] = ticket["publicKey"].clone();
                            g.replica
                                .append("member.add", member, &device, &self.0.key)?;
                        }
                        let t = g.tickets.get_mut(request).unwrap();
                        t["status"] = if allow { "approved" } else { "denied" }.into();
                        if allow {
                            t["approvedEvents"] = json!(g
                                .replica
                                .ordered(None)
                                .into_iter()
                                .cloned()
                                .collect::<Vec<_>>());
                        }
                        let status = t["status"].clone();
                        self.changed(&id, &mut data).await?;
                        Ok(json!({"status":status}))
                    }
                    "rename_group" | "remove_member" | "leave_group" => {
                        let (typ, payload) = match method {
                            "rename_group" => {
                                let mut v = json!({"name":s(&p,"name")});
                                if let Some(animal) = p.get("animalId") {
                                    v["animalId"] = animal.clone()
                                }
                                ("rename", v)
                            }
                            "remove_member" => ("member.remove", json!({"deviceId":p["deviceId"]})),
                            _ => ("member.leave", json!({})),
                        };
                        g.replica.append(typ, payload, &device, &self.0.key)?;
                        if method == "leave_group" {
                            g.hidden = true
                        }
                        self.changed(&id, &mut data).await?;
                        Ok(json!({"ok":true}))
                    }
                    "forget_group" => {
                        ensure!(
                            g.hidden || g.replica.state["dissolved"].as_bool().unwrap_or(false),
                            "先退出群再移除"
                        );
                        g.hidden = true;
                        self.changed(&id, &mut data).await?;
                        Ok(json!({"ok":true}))
                    }
                    _ => bail!("Unsupported core method: {method}"),
                }
            }
        }
    }
    async fn request(&self, url: &str, path: &str, body: Value) -> Result<Value> {
        let permit = self.0.network.acquire().await?;
        let response = self
            .0
            .http
            .post(format!("{}{path}", origin(url)?))
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let bytes = response.bytes().await?;
        ensure!(bytes.len() <= 16 * 1024 * 1024, "Response too large");
        let v: Value = serde_json::from_slice(&bytes)?;
        drop(permit);
        ensure!(status.is_success(), "{}", s(&v, "error"));
        Ok(v)
    }
    async fn check_join(&self, ticket: &Value) -> Result<Value> {
        let base = origin(s(ticket, "baseUrl"))?;
        let path = format!("/api/peer/pair/status/{}", s(ticket, "requestId"));
        let mut offset = 0;
        let mut events = Vec::new();
        let mut genesis = Value::Null;
        let mut result;
        loop {
            let response = self
                .0
                .http
                .get(format!("{base}{path}?offset={offset}"))
                .header("X-Poll-Token", s(ticket, "pollToken"))
                .send()
                .await?
                .error_for_status()?;
            result = response.json::<Value>().await?;
            if s(&result, "status") != "approved" {
                return Ok(result);
            }
            let group = &result["group"];
            ensure!(group["id"] == ticket["groupId"], "Wrong join group");
            let snap = &group["peer"];
            if offset == 0 {
                genesis = snap["genesis"].clone()
            } else {
                ensure!(genesis == snap["genesis"], "Group identity changed")
            };
            events.extend(
                snap["events"]
                    .as_array()
                    .context("Invalid join page")?
                    .iter()
                    .cloned(),
            );
            ensure!(events.len() <= 50000, "History too large");
            if !snap["hasMore"].as_bool().unwrap_or(false) {
                break;
            }
            offset = snap["nextOffset"].as_u64().context("Invalid join offset")? as usize;
            ensure!(offset == events.len(), "Invalid join pagination");
        }
        let replica = Replica::new(genesis, events)?;
        let mut data = self.0.data.lock().await;
        ensure!(
            replica.member(
                s(&data.device, "id"),
                &hex::encode(self.0.key.verifying_key().to_bytes())
            ),
            "Join did not grant identity"
        );
        let id = s(&replica.genesis, "groupId").to_string();
        data.groups.insert(
            id.clone(),
            Group {
                replica,
                peers: BTreeMap::from([(base, s(ticket, "hostDeviceId").into())]),
                remote_known: HashMap::new(),
                invites: HashMap::new(),
                tickets: HashMap::new(),
                hidden: false,
                seen: HashMap::new(),
                presence_revision: 0,
                online: HashSet::new(),
                retry: HashMap::new(),
            },
        );
        data.active = Some(id.clone());
        self.changed(&id, &mut data).await?;
        atomic(
            &self.0.dir.join("settings.json"),
            &json!({"activeGroupId":id}),
        )
        .await?;
        result["group"] = Self::group_list(&data, &self.endpoint())
            .into_iter()
            .find(|g| s(g, "id") == id)
            .unwrap();
        Ok(result)
    }
    async fn sync_all(&self) {
        if self.0.syncing.swap(true, Ordering::AcqRel) {
            return;
        }
        let routes = {
            let mut d = self.0.data.lock().await;
            let now = chrono::Utc::now().timestamp_millis();
            let mut routes = Vec::new();
            for (id, g) in &mut d.groups {
                if presence(g, None) {
                    self.emit(json!({"type":"state","groupId":id,"state":self.state(g,None,60)}));
                }
                let mut urls: Vec<_> = g
                    .peers
                    .keys()
                    .filter(|url| g.retry.get(*url).is_none_or(|(_, until)| *until <= now))
                    .cloned()
                    .collect();
                urls.sort_by_key(|url| {
                    std::cmp::Reverse(g.seen.get(&g.peers[url]).copied().unwrap_or(0))
                });
                routes.extend(urls.into_iter().take(16).map(|url| (id.clone(), url)));
            }
            routes
        };
        stream::iter(routes)
            .for_each_concurrent(4, |(id, url)| {
                let core = self.clone();
                async move {
                    let result = core.sync_route(&id, &url).await;
                    let mut d = core.0.data.lock().await;
                    if let Some(g) = d.groups.get_mut(&id) {
                        if result.is_ok() {
                            g.retry.remove(&url);
                        } else {
                            let count = g.retry.get(&url).map(|(n, _)| *n).unwrap_or(0) + 1;
                            g.retry.insert(
                                url,
                                (
                                    count,
                                    chrono::Utc::now().timestamp_millis()
                                        + 4000 * (1i64 << count.min(6)),
                                ),
                            );
                        }
                    }
                }
            })
            .await;
        self.0.syncing.store(false, Ordering::Release);
    }
    async fn sync_route(&self, id: &str, url: &str) -> Result<()> {
        for _ in 0..16 {
            let proof = {
                let data = self.0.data.lock().await;
                let g = data.groups.get(id).context("Unknown group")?;
                let remote = g.remote_known.get(url);
                let missing: Vec<_> = g
                    .replica
                    .ordered(None)
                    .into_iter()
                    .filter(|e| remote.is_some_and(|known| !known.contains(s(e, "eventId"))))
                    .take(128)
                    .collect();
                g.replica.proof("sync",json!({"genesis":g.replica.genesis,"events":missing,"known":g.replica.events.keys().collect::<Vec<_>>(),"endpoint":self.endpoint(),"peers":g.peers.iter().map(|(url,id)|json!({"baseUrl":url,"deviceId":id})).collect::<Vec<_>>()}),&data.device,&self.0.key)
            };
            let response = self.request(url, "/api/peer/sync", proof).await?;
            let mut data = self.0.data.lock().await;
            let g = data.groups.get_mut(id).context("Unknown group")?;
            let payload = g.replica.verify_proof(&response, "sync-result", true)?;
            ensure!(
                payload["genesis"] == g.replica.genesis,
                "Wrong group genesis"
            );
            let count = g.replica.merge_authorized(
                payload["events"].as_array().cloned().unwrap_or_default(),
                s(&response, "senderDeviceId"),
                s(&response, "senderPublicKey"),
                false,
            )?;
            let presence_changed = presence(g, Some(s(&response, "senderDeviceId")));
            let old_peers = g.peers.clone();
            let route_changed = g
                .peers
                .get(url)
                .is_none_or(|id| id != s(&response, "senderDeviceId"));
            g.peers
                .insert(url.into(), s(&response, "senderDeviceId").into());
            learn(g, &payload, s(&self.endpoint(), "deviceId"));
            if let Some(known) = payload["known"].as_array() {
                g.remote_known.insert(
                    url.into(),
                    known
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect(),
                );
            }
            let done = !payload["hasMore"].as_bool().unwrap_or(false)
                && g.remote_known
                    .get(url)
                    .is_some_and(|known| g.replica.events.keys().all(|id| known.contains(id)));
            if count > 0 || route_changed || old_peers != g.peers {
                self.changed(id, &mut data).await?
            } else if presence_changed {
                self.emit(json!({"type":"state","groupId":id,"state":self.state(&data.groups[id],None,60)}));
            }
            if done {
                break;
            }
        }
        Ok(())
    }
    async fn send_file(
        &self,
        id: &str,
        path: PathBuf,
        transfer_id: &str,
        token: &CancellationToken,
    ) -> Result<Value> {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .context("Invalid file path")?
            .to_string();
        let temp = self
            .0
            .dir
            .join("files")
            .join(format!(".{}.part", random(16)));
        self.emit(json!({"type":"transfer","id":transfer_id,"status":"sending","bytes":0,"total":tokio::fs::metadata(&path).await?.len()}));
        let copied = copy_hash(&path, &temp, self, transfer_id, token).await;
        if copied.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        let (sha, size) = copied?;
        if token.is_cancelled() {
            let _ = tokio::fs::remove_file(&temp).await;
            bail!("已取消");
        }
        let dest = self.0.dir.join("files").join(&sha);
        if dest.exists() {
            tokio::fs::remove_file(&temp).await?
        } else {
            tokio::fs::rename(&temp, &dest).await?
        }
        let mut data = self.0.data.lock().await;
        let device = data.device.clone();
        let g = data.groups.get_mut(id).context("Unknown group")?;
        self.0.transfers.lock().await.remove(transfer_id);
        ensure!(!token.is_cancelled(), "已取消");
        let m = json!({"id":uuid::Uuid::new_v4(),"type":"file","fileName":name,"mime":"application/octet-stream","size":size,"sha256":sha,"senderId":device["id"],"senderName":device["name"],"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        g.replica
            .append("message", m.clone(), &device, &self.0.key)?;
        self.changed(id, &mut data).await?;
        self.kick_sync();
        self.emit(
            json!({"type":"transfer","id":if transfer_id.is_empty(){s(&m,"id")}else{transfer_id},"messageId":m["id"],"status":"completed","bytes":size,"total":size}),
        );
        Ok(m)
    }
    async fn receive_file(
        &self,
        group: &str,
        id: &str,
        transfer_id: &str,
        token: &CancellationToken,
    ) -> Result<Value> {
        let (m, peers, device) = {
            let data = self.0.data.lock().await;
            let g = data.groups.get(group).context("Unknown group")?;
            let m = g.replica.state["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| s(m, "id") == id && s(m, "type") == "file")
                .context("Unknown file")?
                .clone();
            (
                m,
                g.peers.keys().cloned().collect::<Vec<_>>(),
                data.device.clone(),
            )
        };
        let path = self.0.dir.join("files").join(s(&m, "sha256"));
        if path.exists() && tokio::fs::metadata(&path).await?.len() == m["size"].as_u64().unwrap() {
            return Ok(json!({"path":path,"sha256":m["sha256"],"size":m["size"]}));
        }
        for peer in peers {
            let proof = {
                let data = self.0.data.lock().await;
                data.groups[group]
                    .replica
                    .proof("file", json!({"id":id}), &device, &self.0.key)
            };
            let outcome=async {let response=tokio::select!{_=token.cancelled()=>{bail!("已取消")},response=self.0.file_http.get(format!("{peer}/api/peer/files/{id}")).header("X-Peer-Proof",proof.to_string()).send()=>response?}.error_for_status()?;let temp=self.0.dir.join("files").join(format!(".{}.part",random(16)));let result=async{let mut f=tokio::fs::File::create(&temp).await?;let mut stream=response.bytes_stream();let mut hash=Sha256::new();let mut bytes=0u64;let mut last=std::time::Instant::now();loop{let next=tokio::select!{_=token.cancelled()=>{bail!("已取消")},next=tokio::time::timeout(Duration::from_secs(30),stream.next())=>next?};let Some(chunk)=next else{break};let chunk=chunk?;bytes+=chunk.len()as u64;ensure!(bytes<=m["size"].as_u64().unwrap(),"File exceeds signed size");hash.update(&chunk);f.write_all(&chunk).await?;if last.elapsed()>=Duration::from_millis(150){self.emit(json!({"type":"transfer","id":transfer_id,"messageId":id,"status":"receiving","bytes":bytes,"total":m["size"]}));last=std::time::Instant::now();}}ensure!(bytes==m["size"].as_u64().unwrap()&&hex::encode(hash.finalize())==s(&m,"sha256"),"File integrity check failed");f.sync_all().await?;tokio::fs::rename(&temp,&path).await?;Ok::<_,anyhow::Error>(())}.await;if result.is_err(){let _=tokio::fs::remove_file(temp).await;}result}.await;
            if token.is_cancelled() {
                bail!("已取消");
            }
            if outcome.is_ok() {
                self.emit(json!({"type":"transfer","id":transfer_id,"messageId":id,"status":"completed","bytes":m["size"],"total":m["size"],"path":path}));
                return Ok(json!({"path":path,"sha256":m["sha256"],"size":m["size"]}));
            }
        }
        bail!("没有在线设备持有该文件")
    }
    async fn cache_stats(&self) -> Result<(usize, u64)> {
        let mut e = tokio::fs::read_dir(self.0.dir.join("files")).await?;
        let (mut count, mut size) = (0, 0);
        while let Some(f) = e.next_entry().await? {
            let m = f.metadata().await?;
            if m.is_file() {
                count += 1;
                size += m.len()
            }
        }
        Ok((count, size))
    }
}
fn origin(url: &str) -> Result<String> {
    let u = reqwest::Url::parse(url)?;
    ensure!(
        ["http", "https"].contains(&u.scheme())
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str().is_some(),
        "Invalid peer URL"
    );
    Ok(u.origin().ascii_serialization())
}
fn learn(g: &mut Group, p: &Value, self_id: &str) {
    for hint in p["peers"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(p.get("endpoint"))
    {
        if s(hint, "deviceId") == self_id {
            continue;
        }
        if let Ok(url) = origin(s(hint, "baseUrl")) {
            if g.peers.len() < 64 && !g.peers.contains_key(&url) {
                g.peers.insert(url, s(hint, "deviceId").into());
            }
        }
    }
}
async fn atomic(path: &std::path::Path, value: &Value) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", random(8)));
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut f = options.open(&temp).await?;
    f.write_all(&serde_json::to_vec(value)?).await?;
    f.sync_all().await?;
    drop(f);
    tokio::fs::rename(&temp, path).await?;
    Ok(())
}
async fn copy_hash(
    source: &std::path::Path,
    dest: &std::path::Path,
    core: &Core,
    transfer_id: &str,
    token: &CancellationToken,
) -> Result<(String, u64)> {
    let mut input = tokio::fs::File::open(source).await?;
    ensure!(
        input.metadata().await?.is_file(),
        "Only regular files are supported"
    );
    let mut output = tokio::fs::File::create(dest).await?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let total = input.metadata().await?.len();
    let mut last = std::time::Instant::now();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let n =
            tokio::select! {_=token.cancelled()=>{bail!("已取消")},n=input.read(&mut buffer)=>n?};
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        output.write_all(&buffer[..n]).await?;
        size += n as u64;
        if last.elapsed() >= Duration::from_millis(150) {
            core.emit(json!({"type":"transfer","id":transfer_id,"status":"sending","bytes":size,"total":total}));
            last = std::time::Instant::now();
        }
    }
    output.sync_all().await?;
    Ok((hex::encode(hash.finalize()), size))
}
type WebResult = std::result::Result<Response, (StatusCode, Json<Value>)>;
fn web_error(e: anyhow::Error) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":e.to_string()})),
    )
}
async fn info(State(core): State<Core>) -> Json<Value> {
    let data = core.0.data.lock().await;
    Json(json!({"protocol":PROTOCOL,"device":data.device}))
}
async fn discovery(State(core): State<Core>) -> Json<Value> {
    let d = core.0.data.lock().await;
    Json(
        json!({"protocol":"pickdrop-directory-v1","groups":d.groups.iter().filter(|(_,g)|!g.hidden).map(|(id,g)|json!({"groupId":id,"name":g.replica.state["name"],"hostDeviceId":d.device["id"],"port":core.endpoint()["port"],"peerProtocol":PROTOCOL})).collect::<Vec<_>>()}),
    )
}
async fn sync_handler(State(core): State<Core>, Json(proof): Json<Value>) -> WebResult {
    async{ensure!(core.0.active.load(Ordering::Relaxed),"Node paused");let mut d=core.0.data.lock().await;let device=d.device.clone();let id=s(&proof,"groupId");let g=d.groups.get_mut(id).context("Unknown group")?;let p=g.replica.verify_proof(&proof,"sync",true)?;ensure!(p["genesis"]==g.replica.genesis,"Wrong genesis");let was=g.replica.member(s(&proof,"senderDeviceId"),s(&proof,"senderPublicKey"));let count=g.replica.merge_authorized(p["events"].as_array().cloned().unwrap_or_default(),s(&proof,"senderDeviceId"),s(&proof,"senderPublicKey"),was)?;let member=g.replica.member(s(&proof,"senderDeviceId"),s(&proof,"senderPublicKey"));let known:HashSet<_>=p["known"].as_array().into_iter().flatten().filter_map(|v|v.as_str()).collect();let missing:Vec<_>=g.replica.ordered(None).into_iter().filter(|e|!known.contains(s(e,"eventId"))).cloned().collect();let presence_changed=if member{presence(g,Some(s(&proof,"senderDeviceId")))}else{false};let old_peers=g.peers.clone();if member{learn(g,&p,s(&core.endpoint(),"deviceId"))}let response=g.replica.proof("sync-result",json!({"genesis":g.replica.genesis,"events":if member{missing.iter().take(128).cloned().collect::<Vec<_>>()}else{vec![]},"known":g.replica.events.keys().collect::<Vec<_>>(),"hasMore":member&&missing.len()>128,"revoked":was&&!member,"accepted":p["events"].as_array().into_iter().flatten().map(|e|e["eventId"].clone()).collect::<Vec<_>>(),"endpoint":core.endpoint(),"peers":g.peers.iter().map(|(url,id)|json!({"baseUrl":url,"deviceId":id})).collect::<Vec<_>>()}),&device,&core.0.key);if count>0||old_peers!=g.peers{core.changed(id,&mut d).await?}else if presence_changed{core.emit(json!({"type":"state","groupId":id,"state":core.state(&d.groups[id],None,60)}));}Ok(Json(response).into_response())}.await.map_err(web_error)
}
async fn pair_request(State(core): State<Core>, Json(proof): Json<Value>) -> WebResult {
    async{ensure!(core.0.active.load(Ordering::Relaxed),"Node paused");ensure!(s(&proof,"protocol")==PROTOCOL&&s(&proof,"operation")=="join"&&uuid::Uuid::parse_str(s(&proof["device"],"id")).is_ok()&&!s(&proof["device"],"name").is_empty(),"Invalid join");verify(&proof,s(&proof,"publicKey"))?;let mut d=core.0.data.lock().await;let host=d.device["id"].clone();let now=chrono::Utc::now().timestamp_millis();for(id,g)in &mut d.groups{if g.invites.get(s(&proof,"code")).is_some_and(|expires|*expires>now){g.invites.remove(s(&proof,"code"));g.tickets.retain(|_,t|t["expiresAt"].as_i64().unwrap_or(0)+3600000>now);ensure!(g.tickets.len()<100,"Too many requests");let request=random(16);let token=random(32);let ticket=json!({"requestId":request,"pollToken":token,"device":proof["device"],"publicKey":proof["publicKey"],"status":"pending","expiresAt":now+300000});g.tickets.insert(request.clone(),ticket);core.emit(json!({"type":"join_request","groupId":id}));return Ok(Json(json!({"requestId":request,"pollToken":token,"expiresAt":now+300000,"groupId":id,"groupName":g.replica.state["name"],"hostDeviceId":host,"peerProtocol":PROTOCOL})).into_response())}}bail!("邀请码无效或已过期")}.await.map_err(web_error)
}
async fn pair_status(
    State(core): State<Core>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> WebResult {
    async{let data=core.0.data.lock().await;let token=headers.get("x-poll-token").and_then(|v|v.to_str().ok()).unwrap_or("");for(group,g)in &data.groups{if let Some(t)=g.tickets.get(&id){ensure!(s(t,"pollToken")==token,"Invalid poll token");if s(t,"status")=="approved"{if !g.replica.member(s(&t["device"],"id"),s(t,"publicKey")){return Ok(Json(json!({"status":"revoked"})).into_response())}let events=t["approvedEvents"].as_array().unwrap();let offset=query.get("offset").and_then(|s|s.parse::<usize>().ok()).unwrap_or(0).min(events.len());return Ok(Json(json!({"status":"approved","group":{"id":group,"name":g.replica.state["name"],"creatorDeviceId":g.replica.genesis["creatorDeviceId"],"mode":"peer","authVersion":3,"baseUrl":core.endpoint()["baseUrl"],"peer":{"genesis":g.replica.genesis,"events":events[offset..(offset+128).min(events.len())],"nextOffset":offset+128,"hasMore":offset+128<events.len()}}})).into_response())}return Ok(Json(json!({"status":if t["expiresAt"].as_i64().unwrap_or(0)<=chrono::Utc::now().timestamp_millis(){"expired"}else{s(t,"status")}})).into_response())}}bail!("加入申请不存在")}.await.map_err(web_error)
}
async fn file_handler(
    State(core): State<Core>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> WebResult {
    async {
        ensure!(core.0.active.load(Ordering::Relaxed), "Node paused");
        let proof: Value = serde_json::from_str(
            headers
                .get("x-peer-proof")
                .and_then(|v| v.to_str().ok())
                .context("Missing proof")?,
        )?;
        let mut data = core.0.data.lock().await;
        let g = data
            .groups
            .get_mut(s(&proof, "groupId"))
            .context("Unknown group")?;
        let p = g.replica.verify_proof(&proof, "file", false)?;
        ensure!(s(&p, "id") == id, "Wrong file proof");
        let m = g.replica.state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| s(m, "id") == id && s(m, "type") == "file")
            .context("Unknown file")?;
        let path = core.0.dir.join("files").join(s(m, "sha256"));
        let size = m["size"].as_u64().unwrap();
        drop(data);
        let file = tokio::fs::File::open(path).await?;
        ensure!(file.metadata().await?.len() == size, "Missing file");
        Ok(Response::builder()
            .header("content-type", "application/octet-stream")
            .header("content-length", size)
            .body(Body::from_stream(tokio_util::io::ReaderStream::new(file)))?)
    }
    .await
    .map_err(web_error)
}

fn presence(g: &mut Group, sender: Option<&str>) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    if let Some(id) = sender {
        g.seen.insert(id.into(), now);
    }
    g.seen.retain(|_, seen| now - *seen < 15000);
    let online: HashSet<_> = g.seen.keys().cloned().collect();
    if online != g.online {
        g.online = online;
        g.presence_revision += 1;
        true
    } else {
        false
    }
}
