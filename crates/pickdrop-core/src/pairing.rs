//! Invitations, join decisions, and verified admission of the local device.
use crate::{
    atomic,
    network::origin,
    protocol::{s, sign, Replica, PROTOCOL},
    Core, Group,
};
use anyhow::{ensure, Context, Result};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

impl Core {
    pub(super) fn start_pending_join_checks(&self) {
        let weak = std::sync::Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(4));
            loop {
                interval.tick().await;
                let Some(inner) = weak.upgrade() else { break };
                let core = Core(inner);
                if core.0.shutdown.is_cancelled() {
                    break;
                }
                if core.0.active.load(std::sync::atomic::Ordering::Relaxed) {
                    // A slow invitation host must not stall established peer sync.
                    tokio::select! {
                        _ = core.0.shutdown.cancelled() => break,
                        _ = core.finish_pending_joins() => {}
                    }
                }
            }
        });
    }
    pub(super) async fn join_group(&self, params: &Value) -> Result<Value> {
        ensure!(
            self.0.data.lock().await.pending_joins.len() < 20,
            "待确认的入群申请过多"
        );
        let address = origin(s(params, "address"))?;
        let data = self.0.data.lock().await;
        let proof = sign(
            json!({
                "protocol": PROTOCOL,
                "operation": "join",
                "code": s(params, "code"),
                "device": data.device,
                "publicKey": hex::encode(self.0.key.verifying_key().to_bytes())
            }),
            &self.0.key,
        );
        drop(data);
        let mut ticket = self
            .post_peer_json(&address, "/api/peer/pair/request", proof)
            .await?;
        ensure!(
            ticket["groupId"].is_string()
                && s(&ticket, "requestId").len() == 32
                && s(&ticket, "pollToken").len() == 64,
            "Invalid join ticket"
        );
        ticket["baseUrl"] = address.into();
        let mut data = self.0.data.lock().await;
        let mut pending = data.pending_joins.clone();
        pending.insert(s(&ticket, "requestId").into(), ticket.clone());
        atomic(&self.0.dir.join("pending-joins.json"), &json!(pending)).await?;
        data.pending_joins = pending;
        Ok(ticket)
    }
    pub(super) async fn finish_pending_joins(&self) {
        let tickets: Vec<_> = self
            .0
            .data
            .lock()
            .await
            .pending_joins
            .values()
            .cloned()
            .collect();
        stream::iter(tickets)
            .for_each_concurrent(4, |ticket| async move {
                let expires = ticket["expiresAt"].as_i64().unwrap_or(0);
                // The host retains an approved ticket for an hour after its deadline.
                let result = if chrono::Utc::now().timestamp_millis() > expires + 3_600_000 {
                    self.remove_pending_join(&ticket).await
                } else {
                    self.check_join(&ticket).await.map(|_| ())
                };
                if let Err(error) = result {
                    eprintln!(
                        "Pending join {} could not complete: {error}",
                        s(&ticket, "groupId")
                    );
                }
            })
            .await;
    }
    async fn remove_pending_join(&self, ticket: &Value) -> Result<()> {
        let mut data = self.0.data.lock().await;
        if data.pending_joins.contains_key(s(ticket, "requestId")) {
            let mut pending = data.pending_joins.clone();
            pending.remove(s(ticket, "requestId"));
            atomic(&self.0.dir.join("pending-joins.json"), &json!(pending)).await?;
            data.pending_joins = pending;
        }
        Ok(())
    }
    pub(super) async fn check_join(&self, ticket: &Value) -> Result<Value> {
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
                if ["denied", "expired", "revoked"].contains(&s(&result, "status")) {
                    self.remove_pending_join(ticket).await?;
                }
                return Ok(result);
            }
            let group = &result["group"];
            ensure!(group["id"] == ticket["groupId"], "Wrong join group");
            let snapshot = &group["peer"];
            if offset == 0 {
                genesis = snapshot["genesis"].clone()
            } else {
                ensure!(genesis == snapshot["genesis"], "Group identity changed")
            };
            events.extend(
                snapshot["events"]
                    .as_array()
                    .context("Invalid join page")?
                    .iter()
                    .cloned(),
            );
            ensure!(events.len() <= 50000, "History too large");
            if !snapshot["hasMore"].as_bool().unwrap_or(false) {
                break;
            }
            offset = snapshot["nextOffset"]
                .as_u64()
                .context("Invalid join offset")? as usize;
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
        let select_joined = data.groups.get(&id).is_none_or(|group| group.hidden);
        if let Some(group) = data.groups.get_mut(&id) {
            ensure!(
                group.replica.genesis == replica.genesis,
                "Group identity changed"
            );
            // A UI poll and background completion may race. Merge verified events
            // instead of replacing messages and permissions learned since approval.
            group
                .replica
                .merge(replica.events.into_values().collect())?;
            ensure!(
                group.replica.member(
                    s(&self.endpoint(), "deviceId"),
                    &hex::encode(self.0.key.verifying_key().to_bytes())
                ),
                "入群授权已失效"
            );
            group.hidden = false;
            group.peers.insert(base, s(ticket, "hostDeviceId").into());
        } else {
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
                    route_hints: HashMap::new(),
                    route_seen: HashMap::new(),
                },
            );
        }
        if select_joined {
            data.active = Some(id.clone());
        }
        self.changed(&id, &mut data).await?;
        if select_joined {
            atomic(
                &self.0.dir.join("settings.json"),
                &json!({"activeGroupId":id}),
            )
            .await?;
        }
        result["group"] = Self::group_list(&data, &self.endpoint())
            .into_iter()
            .find(|g| s(g, "id") == id)
            .unwrap();
        drop(data);
        self.remove_pending_join(ticket).await?;
        self.kick_sync();
        Ok(result)
    }
    pub(super) fn create_invite(
        &self,
        id: &str,
        group: &mut Group,
        device: &Value,
    ) -> Result<Value> {
        ensure!(
            group.replica.member(
                s(device, "id"),
                &hex::encode(self.0.key.verifying_key().to_bytes())
            ) && !group.replica.state["dissolved"].as_bool().unwrap_or(false),
            "Not an active member"
        );
        let now = chrono::Utc::now().timestamp_millis();
        group.invites.retain(|_, expires| *expires > now);
        ensure!(group.invites.len() < 20, "Too many invitations");
        let code = loop {
            let code = format!("{:06}", rand::random::<u32>() % 1000000);
            if !group.invites.contains_key(&code) {
                break code;
            }
        };
        let expires = now + 300000;
        group.invites.insert(code.clone(), expires);
        Ok(json!({
            "code": code,
            "expiresAt": expires,
            "baseUrl": self.endpoint()["baseUrl"],
            "groupId": id,
            "link": format!("{}/#invite={code}&group={id}&protocol=peer", s(&self.endpoint(), "baseUrl"))
        }))
    }
    pub(super) fn pending_join_requests(group: &Group) -> Value {
        json!(group
            .tickets
            .values()
            .filter(|ticket| s(ticket, "status") == "pending"
                && ticket["expiresAt"].as_i64().unwrap_or(0)
                    > chrono::Utc::now().timestamp_millis())
            .map(|ticket| {
                let mut ticket = ticket.clone();
                ticket.as_object_mut().unwrap().remove("pollToken");
                ticket["id"] = ticket["requestId"].clone();
                ticket
            })
            .collect::<Vec<_>>())
    }
    pub(super) fn decide_join_request(
        &self,
        group: &mut Group,
        device: &Value,
        params: &Value,
    ) -> Result<Value> {
        let request = s(params, "id");
        let ticket = group
            .tickets
            .get(request)
            .context("加入申请不存在")?
            .clone();
        ensure!(
            s(&ticket, "status") == "pending"
                && ticket["expiresAt"].as_i64().unwrap_or(0)
                    > chrono::Utc::now().timestamp_millis(),
            "申请已过期或已处理"
        );
        let allow = params["allow"].as_bool().context("Invalid decision")?;
        if allow {
            let mut member = ticket["device"].clone();
            member["publicKey"] = ticket["publicKey"].clone();
            group
                .replica
                .append("member.add", member, device, &self.0.key)?;
        }
        let saved_ticket = group.tickets.get_mut(request).unwrap();
        saved_ticket["status"] = if allow { "approved" } else { "denied" }.into();
        if allow {
            saved_ticket["approvedEvents"] = json!(group
                .replica
                .ordered(None)
                .into_iter()
                .cloned()
                .collect::<Vec<_>>());
        }
        let status = saved_ticket["status"].clone();
        Ok(json!({"status":status}))
    }
}
