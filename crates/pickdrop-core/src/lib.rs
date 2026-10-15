mod files;
mod http;
mod migration;
mod network;
mod pairing;
mod sync;
pub mod protocol;

use anyhow::{bail, ensure, Context, Result};
use ed25519_dalek::SigningKey;
use files::project_cached_message;
use network::{bind_listener, format_peer_url, origin, preferred_lan_ip, validate_discovery_hint};
use protocol::*;
use serde_json::{json, Value};
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
    io::AsyncWriteExt,
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
    shutdown: CancellationToken,
    server_stopped: AtomicBool,
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
    route_hints: HashMap<String, i64>,
    route_seen: HashMap<String, i64>,
}
impl Core {
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
        let saved_settings = tokio::fs::read(dir.join("settings.json"))
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({}));
        let saved_network = tokio::fs::read(dir.join("network.json"))
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({}));
        let preferred = saved_network["listenerPort"]
            .as_u64()
            .or(saved_settings["listenPort"].as_u64())
            .filter(|port| *port > 0 && *port <= 65535)
            .map(|port| port as u16);
        let listener = bind_listener(preferred).await?;
        let port = listener.local_addr()?.port();
        let ip = preferred_lan_ip().unwrap_or("127.0.0.1".parse().unwrap());
        let endpoint =
            json!({"baseUrl":format!("http://{ip}:{port}"),"port":port,"deviceId":device["id"]});
        let mut groups: BTreeMap<String, Group> = BTreeMap::new();
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("group_") && name.ends_with(".json") {
                let saved: Value = serde_json::from_slice(&tokio::fs::read(entry.path()).await?)?;
                let replica = Replica::from_snapshot(&saved)
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
                        route_hints: HashMap::new(),
                        route_seen: HashMap::new(),
                    },
                );
            }
        }
        let active = saved_settings["activeGroupId"]
            .as_str()
            .map(str::to_owned)
            .filter(|id| groups.get(id).is_some_and(|group| !group.hidden))
            .or_else(|| {
                groups
                    .iter()
                    .find(|(_, group)| !group.hidden)
                    .map(|(id, _)| id.clone())
            });
        if saved_settings["activeGroupId"] != json!(active) {
            let mut settings = saved_settings.clone();
            settings["activeGroupId"] = json!(active);
            atomic(&dir.join("settings.json"), &settings).await?;
        }
        atomic(&dir.join("network.json"), &json!({"listenerPort":port})).await?;
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
            shutdown: CancellationToken::new(),
            server_stopped: AtomicBool::new(false),
        }));
        let router = http::router(core.clone());
        let shutdown = core.0.shutdown.clone();
        let server_core = core.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await;
            server_core.0.server_stopped.store(true, Ordering::Release);
        });
        let weak = Arc::downgrade(&core.0);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(4));
            loop {
                interval.tick().await;
                let Some(inner) = weak.upgrade() else { break };
                let core = Core(inner);
                if core.0.shutdown.is_cancelled() {
                    break;
                }
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
    /// Stop listeners and periodic work without changing identity, groups or cached files.
    pub async fn shutdown(&self) {
        self.0.active.store(false, Ordering::Release);
        for token in self.0.transfers.lock().await.values() {
            token.cancel();
        }
        self.0.shutdown.cancel();
        if let Some(daemon) = &self.0.mdns {
            let _ = daemon.shutdown();
        }
        while !self.0.server_stopped.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    fn endpoint(&self) -> Value {
        self.0.endpoint.read().unwrap().clone()
    }
    async fn refresh_network(&self) {
        let Some(ip) = preferred_lan_ip() else {
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
                if core.0.shutdown.is_cancelled() {
                    break;
                }
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
                        let mut addresses: Vec<_> = info
                            .get_addresses()
                            .iter()
                            .map(|addr| addr.to_ip_addr())
                            .collect();
                        addresses.sort_by_key(|addr| !addr.is_ipv4());
                        for addr in addresses {
                            if let std::net::IpAddr::V6(ip) = addr {
                                if ip.is_unicast_link_local() {
                                    continue;
                                }
                            }
                            let base = format_peer_url(addr, info.get_port());
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
                                    g.retry.remove(&base);
                                    g.route_hints.insert(
                                        base.clone(),
                                        chrono::Utc::now().timestamp_millis(),
                                    );
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
                let mut m = project_cached_message(&self.0.dir, m);
                m["sequence"] = json!(start + i + 1);
                m
            })
            .collect();
        state["cacheRevision"] = json!(messages
            .iter()
            .filter(|m| m["localPath"].is_string())
            .map(|m| s(m, "id"))
            .collect::<Vec<_>>()
            .join(","));
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
            .filter(|(url, _)| !g.route_hints.contains_key(*url) || g.route_seen.contains_key(*url))
            .map(|(url, id)| json!({"baseUrl":url,"deviceId":id}))
            .collect::<Vec<_>>());
        atomic(&self.0.dir.join(format!("group_{id}.json")), &value).await
    }
    async fn repair_active_selection(&self, data: &mut Data) -> Result<()> {
        if data
            .active
            .as_ref()
            .is_some_and(|id| data.groups.get(id).is_none_or(|group| group.hidden))
        {
            let next = data
                .groups
                .iter()
                .find(|(_, group)| !group.hidden)
                .map(|(id, _)| id.clone());
            atomic(
                &self.0.dir.join("settings.json"),
                &json!({"activeGroupId":next}),
            )
            .await?;
            data.active = next;
        }
        Ok(())
    }
    async fn changed(&self, id: &str, data: &mut Data) -> Result<()> {
        let g = &data.groups[id];
        if let Err(error) = self.persist(id, g).await {
            // Restore the last committed snapshot on a failed atomic write; no uncommitted state is emitted.
            let path = self.0.dir.join(format!("group_{id}.json"));
            if let Ok(bytes) = tokio::fs::read(path).await {
                if let Ok(saved) = serde_json::from_slice::<Value>(&bytes) {
                    if let Ok(mut replica) = Replica::from_snapshot(&saved) {
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
        if method == "connect_peer" {
            return self.connect_peer(s(&p, "groupId"), s(&p, "address")).await;
        }
        if method == "remember_discovery" {
            let records = p["records"]
                .as_array()
                .context("Invalid discovery records")?;
            ensure!(records.len() <= 128, "Too many discovery records");
            // Validate the entire input before touching route state. NSD TXT is untrusted.
            let validated: Vec<_> = records
                .iter()
                .map(validate_discovery_hint)
                .collect::<Result<_>>()?;
            let mut data = self.0.data.lock().await;
            let mut accepted = 0usize;
            for hint in validated {
                let group = s(&hint, "groupId");
                let device = s(&hint, "hostDeviceId");
                if device == s(&data.device, "id") {
                    continue;
                }
                let mut discovered = self.0.discovered.lock().await;
                discovered.retain(|_, record| {
                    chrono::Utc::now().timestamp_millis() - record["seenAt"].as_i64().unwrap_or(0)
                        < 120000
                });
                if discovered.len() < 1024
                    || discovered.contains_key(&format!("{group}:{}", s(&hint, "baseUrl")))
                {
                    discovered.insert(format!("{group}:{}", s(&hint, "baseUrl")), hint.clone());
                }
                drop(discovered);
                if let Some(g) = data.groups.get_mut(group) {
                    if !g.replica.state["members"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|m| s(m, "id") == device)
                    {
                        continue;
                    }
                    let base = s(&hint, "baseUrl");
                    if g.peers.len() >= 64 && !g.peers.contains_key(base) {
                        continue;
                    }
                    g.peers.insert(base.into(), device.into());
                    g.route_hints
                        .insert(base.into(), chrono::Utc::now().timestamp_millis());
                    g.retry.remove(base);
                    accepted += 1;
                }
            }
            drop(data);
            if !records.is_empty() {
                self.emit(json!({"type":"discovery"}));
            }
            if accepted > 0 {
                self.kick_sync();
            }
            return Ok(json!({"accepted":accepted}));
        }
        if method == "discover_groups" {
            let mut records = self.0.discovered.lock().await;
            records.retain(|_, record| {
                chrono::Utc::now().timestamp_millis() - record["seenAt"].as_i64().unwrap_or(0)
                    < 120000
            });
            return Ok(json!(records.values().cloned().collect::<Vec<_>>()));
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
            return self.join_group(&p).await;
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
                json!({"device":device,"groups":Self::group_list(&data,&self.endpoint()),"activeGroupId":data.active.as_ref().filter(|id| data.groups.get(*id).is_some_and(|group| !group.hidden)),"endpoint":self.endpoint()}),
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
                        route_hints: HashMap::new(),
                        route_seen: HashMap::new(),
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
                ensure!(
                    data.groups.get(id).is_some_and(|group| !group.hidden),
                    "群不存在或已移除"
                );
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
                    "create_invite" => self.create_invite(&id, g, &device),
                    "list_join_requests" => Ok(Self::pending_join_requests(g)),
                    "respond_join" => {
                        let response = self.decide_join_request(g, &device, &p)?;
                        self.changed(&id, &mut data).await?;
                        Ok(response)
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
                        if method == "leave_group" {
                            self.repair_active_selection(&mut data).await?;
                        }
                        Ok(json!({"ok":true}))
                    }
                    "forget_group" => {
                        ensure!(
                            g.hidden
                                || g.replica.state["dissolved"].as_bool().unwrap_or(false)
                                || !g.replica.member(
                                    s(&device, "id"),
                                    &hex::encode(self.0.key.verifying_key().to_bytes())
                                ),
                            "先退出群再移除"
                        );
                        g.hidden = true;
                        self.changed(&id, &mut data).await?;
                        self.repair_active_selection(&mut data).await?;
                        Ok(json!({"ok":true}))
                    }
                    _ => bail!("Unsupported core method: {method}"),
                }
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
