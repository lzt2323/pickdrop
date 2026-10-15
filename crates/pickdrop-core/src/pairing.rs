//! Invitations, join decisions, and verified admission of the local device.
use crate::{
    atomic,
    network::origin,
    protocol::{s, sign, Replica, PROTOCOL},
    Core, Group,
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

impl Core {
    pub(super) async fn join_group(&self, params: &Value) -> Result<Value> {
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
        Ok(ticket)
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
