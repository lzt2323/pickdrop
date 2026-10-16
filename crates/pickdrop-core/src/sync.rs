//! Authenticated route synchronization, backoff, and online presence.
use crate::{
    network::origin,
    protocol::{s, PROTOCOL},
    Core, Group,
};
use anyhow::{ensure, Context, Result};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::atomic::Ordering};

impl Core {
    pub(super) fn kick_sync(&self) {
        let core = self.clone();
        tokio::spawn(async move {
            if core.0.active.load(Ordering::Relaxed) {
                core.sync_all().await;
            }
        });
    }
    pub(super) async fn sync_all(&self) {
        if self.0.syncing.swap(true, Ordering::AcqRel) {
            return;
        }
        let routes = {
            let mut data = self.0.data.lock().await;
            let now = chrono::Utc::now().timestamp_millis();
            let mut routes = Vec::new();
            for (group_id, group) in &mut data.groups {
                if update_presence(group, None) {
                    self.emit(
                        json!({"type":"state","groupId":group_id,"state":self.state(group,None,60)}),
                    );
                }
                let mut urls: Vec<_> = group
                    .peers
                    .keys()
                    .filter(|url| group.retry.get(*url).is_none_or(|(_, until)| *until <= now))
                    .cloned()
                    .collect();
                urls.sort_by_key(|url| {
                    let verified = group.route_seen.get(url).copied().unwrap_or(0);
                    let hinted = group.route_hints.get(url).copied().unwrap_or(0);
                    std::cmp::Reverse((
                        if now - verified < 15000 {
                            2
                        } else if now - hinted < 15000 {
                            1
                        } else {
                            0
                        },
                        verified.max(hinted),
                    ))
                });
                routes.extend(urls.into_iter().take(16).map(|url| (group_id.clone(), url)));
            }
            routes
        };
        stream::iter(routes)
            .for_each_concurrent(4, |(group_id, url)| {
                let core = self.clone();
                async move {
                    let result = core.sync_route(&group_id, &url).await;
                    let mut data = core.0.data.lock().await;
                    if let Some(group) = data.groups.get_mut(&group_id) {
                        if result.is_ok() {
                            group.retry.remove(&url);
                        } else {
                            let count = group.retry.get(&url).map(|(n, _)| *n).unwrap_or(0) + 1;
                            group.retry.insert(
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
    pub(super) async fn connect_peer(&self, group_id: &str, address: &str) -> Result<Value> {
        ensure!(self.0.active.load(Ordering::Relaxed), "设备节点已暂停");
        let url = reqwest::Url::parse(address)?;
        let address = origin(address)?;
        ensure!(
            url.path() == "/" && url.query().is_none() && url.fragment().is_none(),
            "设备地址只填写地址与端口"
        );
        let info = self
            .0
            .http
            .get(format!("{address}/api/peer/info"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        ensure!(
            s(&info, "protocol") == PROTOCOL
                && uuid::Uuid::parse_str(s(&info["device"], "id")).is_ok(),
            "设备不支持此同步协议"
        );
        {
            let data = self.0.data.lock().await;
            let group = data.groups.get(group_id).context("群不存在")?;
            ensure!(
                group.replica.state["members"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["id"] == info["device"]["id"]),
                "该设备不是此群成员，请通过邀请码加入"
            );
            ensure!(info["device"]["id"] != data.device["id"], "不能连接本设备");
        }
        self.sync_route_expected(group_id, &address, Some(s(&info["device"], "id")))
            .await?;
        let data = self.0.data.lock().await;
        Ok(
            json!({"ok":true,"address":address,"device":info["device"],"state":self.state(&data.groups[group_id],None,60)}),
        )
    }
    async fn sync_route(&self, group_id: &str, url: &str) -> Result<()> {
        self.sync_route_expected(group_id, url, None).await
    }
    async fn sync_route_expected(
        &self,
        group_id: &str,
        url: &str,
        expected_device_id: Option<&str>,
    ) -> Result<()> {
        for _ in 0..16 {
            let proof = {
                let data = self.0.data.lock().await;
                let group = data.groups.get(group_id).context("Unknown group")?;
                let remote = group.remote_known.get(url);
                let missing: Vec<_> = group
                    .replica
                    .ordered(None)
                    .into_iter()
                    .filter(|e| remote.is_some_and(|known| !known.contains(s(e, "eventId"))))
                    .take(128)
                    .collect();
                group.replica.proof(
                    "sync",
                    json!({
                        "genesis": group.replica.genesis,
                        "events": missing,
                        "known": group.replica.events.keys().collect::<Vec<_>>(),
                        "endpoint": self.endpoint(),
                        "peers": group.peers.iter().map(|(url, device_id)| {
                            json!({"baseUrl": url, "deviceId": device_id})
                        }).collect::<Vec<_>>()
                    }),
                    &data.device,
                    &self.0.key,
                )
            };
            let response = self.post_peer_json(url, "/api/peer/sync", proof).await?;
            let mut data = self.0.data.lock().await;
            let group = data.groups.get_mut(group_id).context("Unknown group")?;
            ensure!(
                expected_device_id
                    .is_none_or(|device_id| s(&response, "senderDeviceId") == device_id),
                "响应设备身份与地址不符"
            );
            let payload = group.replica.verify_proof(&response, "sync-result", true)?;
            ensure!(
                payload["genesis"] == group.replica.genesis,
                "Wrong group genesis"
            );
            let receipts = payload["revocations"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            ensure!(receipts.len() <= 1, "Too many targeted revocations");
            for receipt in &receipts {
                group
                    .replica
                    .verify_revocation(receipt, s(&self.endpoint(), "deviceId"))?;
            }
            let mut count = group.replica.merge_authorized(
                payload["events"].as_array().cloned().unwrap_or_default(),
                s(&response, "senderDeviceId"),
                s(&response, "senderPublicKey"),
                false,
            )?;
            for receipt in receipts {
                count += group
                    .replica
                    .accept_revocation(receipt, s(&self.endpoint(), "deviceId"))?;
            }
            let locally_revoked = !group.replica.member(
                s(&self.endpoint(), "deviceId"),
                &hex::encode(self.0.key.verifying_key().to_bytes()),
            );
            let newly_verified = !group.route_seen.contains_key(url);
            group
                .route_seen
                .insert(url.into(), chrono::Utc::now().timestamp_millis());
            let presence_changed = update_presence(group, Some(s(&response, "senderDeviceId")));
            let old_peers = group.peers.clone();
            let route_changed = newly_verified
                || group
                    .peers
                    .get(url)
                    .is_none_or(|device_id| device_id != s(&response, "senderDeviceId"));
            group
                .peers
                .insert(url.into(), s(&response, "senderDeviceId").into());
            learn_peer_routes(group, &payload, s(&self.endpoint(), "deviceId"));
            if let Some(known) = payload["known"].as_array() {
                group.remote_known.insert(
                    url.into(),
                    known
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect(),
                );
            }
            let done = locally_revoked
                || !payload["hasMore"].as_bool().unwrap_or(false)
                    && group.remote_known.get(url).is_some_and(|known| {
                        group
                            .replica
                            .events
                            .keys()
                            .all(|event_id| known.contains(event_id))
                    });
            if count > 0 || route_changed || old_peers != group.peers {
                self.changed(group_id, &mut data).await?
            } else if presence_changed {
                self.emit(json!({"type":"state","groupId":group_id,"state":self.state(&data.groups[group_id],None,60)}));
            }
            if done {
                break;
            }
        }
        Ok(())
    }
}

pub(super) fn learn_peer_routes(group: &mut Group, payload: &Value, self_id: &str) {
    for hint in payload["peers"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(payload.get("endpoint"))
    {
        if s(hint, "deviceId") == self_id {
            continue;
        }
        if let Ok(url) = origin(s(hint, "baseUrl")) {
            if group.peers.len() < 64 && !group.peers.contains_key(&url) {
                group.peers.insert(url, s(hint, "deviceId").into());
            }
        }
    }
}
pub(super) fn update_presence(group: &mut Group, sender: Option<&str>) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    if let Some(device_id) = sender {
        group.seen.insert(device_id.into(), now);
    }
    group.seen.retain(|_, seen| now - *seen < 15000);
    let online: HashSet<_> = group.seen.keys().cloned().collect();
    if online != group.online {
        group.online = online;
        group.presence_revision += 1;
        true
    } else {
        false
    }
}
