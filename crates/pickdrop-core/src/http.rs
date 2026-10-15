//! HTTP boundary for peer discovery, synchronization, pairing, and file reads.
use crate::{
    network::origin,
    protocol::{random, s, verify, PROTOCOL},
    sync::{learn_peer_routes, update_presence},
    Core,
};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::Ordering,
};

pub(super) fn router(core: Core) -> Router {
    Router::new()
        .route("/api/peer/info", get(info))
        .route("/api/discovery/groups", get(discovery))
        .route("/api/peer/sync", post(sync_handler))
        .route("/api/peer/pair/request", post(pair_request))
        .route("/api/peer/pair/status/{id}", get(pair_status))
        .route("/api/peer/files/{id}", get(file_handler))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(core)
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
    Json(json!({"protocol":PROTOCOL,"device":data.device,"endpoint":core.endpoint()}))
}
async fn discovery(State(core): State<Core>) -> Json<Value> {
    let d = core.0.data.lock().await;
    Json(
        json!({"protocol":"pickdrop-directory-v1","groups":d.groups.iter().filter(|(_,g)|!g.hidden).map(|(id,g)|json!({"groupId":id,"name":g.replica.state["name"],"hostDeviceId":d.device["id"],"port":core.endpoint()["port"],"peerProtocol":PROTOCOL})).collect::<Vec<_>>()}),
    )
}
async fn sync_handler(State(core): State<Core>, Json(proof): Json<Value>) -> WebResult {
    async {
        ensure!(core.0.active.load(Ordering::Relaxed), "Node paused");
        let mut data = core.0.data.lock().await;
        let device = data.device.clone();
        let id = s(&proof, "groupId");
        let g = data.groups.get_mut(id).context("Unknown group")?;
        let payload = g.replica.verify_proof(&proof, "sync", true)?;
        ensure!(payload["genesis"] == g.replica.genesis, "Wrong genesis");
        let sender = s(&proof, "senderDeviceId");
        let key = s(&proof, "senderPublicKey");
        let was_member = g.replica.member(sender, key);
        let count = match g.replica.merge_authorized(
            payload["events"].as_array().cloned().unwrap_or_default(), sender, key, was_member,
        ) {
            Ok(count) => count,
            // A stale removed peer receives its receipt after the rejected batch is rolled back.
            // New identities may still forward an authorized admission from another member.
            Err(_) if !was_member && g.replica.revocation_for(sender, key).is_some() => 0,
            Err(error) => return Err(error),
        };
        let member = g.replica.member(sender, key);
        let known: HashSet<_> = payload["known"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
        let missing: Vec<_> = if member { g.replica.ordered(None).into_iter().filter(|event| !known.contains(s(event, "eventId"))).cloned().collect() } else { vec![] };
        let presence_changed = member && update_presence(g, Some(sender));
        let old_peers = g.peers.clone();
        if member { learn_peer_routes(g, &payload, s(&core.endpoint(), "deviceId")); }
        let receipt = if member { None } else { g.replica.revocation_for(sender, key) };
        let response = g.replica.proof("sync-result", json!({
            "genesis":g.replica.genesis,
            "events":missing.iter().take(128).cloned().collect::<Vec<_>>(),
            "revocations":receipt.into_iter().collect::<Vec<_>>(),
            "known":if member {g.replica.events.keys().cloned().collect::<Vec<_>>()} else {vec![]},
            "hasMore":member && missing.len()>128,
            "revoked":!member,
            "accepted":if member {payload["events"].as_array().into_iter().flatten().map(|event| event["eventId"].clone()).collect::<Vec<_>>()} else {vec![]},
            "endpoint":core.endpoint(),
            "peers":if member {g.peers.iter().map(|(url,id)|json!({"baseUrl":url,"deviceId":id})).collect::<Vec<_>>()} else {vec![]}
        }), &device, &core.0.key);
        if count>0 || old_peers!=g.peers { core.changed(id, &mut data).await?; }
        else if presence_changed { core.emit(json!({"type":"state","groupId":id,"state":core.state(&data.groups[id],None,60)})); }
        Ok(Json(response).into_response())
    }.await.map_err(web_error)
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

impl Core {
    pub(super) async fn post_peer_json(&self, url: &str, path: &str, body: Value) -> Result<Value> {
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
        let payload: Value = serde_json::from_slice(&bytes)?;
        drop(permit);
        ensure!(status.is_success(), "{}", s(&payload, "error"));
        Ok(payload)
    }
}
