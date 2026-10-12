use pickdrop_core::Core;
use serde_json::{json, Value};
use std::time::Duration;
async fn bootstrap(core: &Core) -> Value {
    core.dispatch("bootstrap", json!({})).await.unwrap()
}
async fn state(core: &Core, id: &str) -> Value {
    core.dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap()
}
async fn wait_count(core: &Core, id: &str, count: usize) {
    for _ in 0..100 {
        if state(core, id).await["messages"].as_array().unwrap().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("sync timeout")
}
#[tokio::test]
async fn listener_port_survives_real_shutdown_restart_and_selection_and_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    let first = bootstrap(&core).await;
    let port = first["endpoint"]["port"].as_u64().unwrap() as u16;
    let group = core
        .dispatch("create_group", json!({"name":"固定端口"}))
        .await
        .unwrap();
    core.dispatch("select_group", json!({"id":group["id"]}))
        .await
        .unwrap();
    let network: Value = serde_json::from_slice(
        &tokio::fs::read(dir.path().join("network.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(network["listenerPort"], port);
    core.shutdown().await;
    let reopened = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    assert_eq!(bootstrap(&reopened).await["endpoint"]["port"], port);
    assert_eq!(bootstrap(&reopened).await["activeGroupId"], group["id"]);
    reopened.shutdown().await;
    let occupied = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port))
        .await
        .unwrap();
    let conflict = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    let new_port = bootstrap(&conflict).await["endpoint"]["port"]
        .as_u64()
        .unwrap() as u16;
    assert_ne!(new_port, port);
    let network: Value = serde_json::from_slice(
        &tokio::fs::read(dir.path().join("network.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(network["listenerPort"], new_port);
    conflict.shutdown().await;
    drop(occupied);
    let final_core = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    assert_eq!(bootstrap(&final_core).await["endpoint"]["port"], new_port);
    final_core.shutdown().await;
}
#[tokio::test]
async fn connect_peer_authenticates_new_route_then_stable_port_recovers_after_restart() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = Core::open(a_dir.path().to_owned(), "desktop")
        .await
        .unwrap();
    let b = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    let group = a
        .dispatch("create_group", json!({"name":"直接重连"}))
        .await
        .unwrap();
    let id = group["id"].as_str().unwrap();
    let invite = a
        .dispatch("create_invite", json!({"groupId":id}))
        .await
        .unwrap();
    let ticket = b
        .dispatch(
            "join_group",
            json!({"address":invite["baseUrl"],"code":invite["code"]}),
        )
        .await
        .unwrap();
    a.dispatch(
        "respond_join",
        json!({"groupId":id,"id":ticket["requestId"],"allow":true}),
    )
    .await
    .unwrap();
    b.dispatch("check_join", json!({"ticket":ticket}))
        .await
        .unwrap();
    b.dispatch("send_text", json!({"groupId":id,"text":"重启前"}))
        .await
        .unwrap();
    wait_count(&a, id, 1).await;
    let before = state(&a, id).await["messages"].clone();
    let old_port = bootstrap(&b).await["endpoint"]["port"].as_u64().unwrap() as u16;
    b.shutdown().await;
    let occupied = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, old_port))
        .await
        .unwrap();
    let b2 = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    let new_endpoint = bootstrap(&b2).await["endpoint"].clone();
    assert_ne!(new_endpoint["port"], old_port);
    let connected = a
        .dispatch(
            "connect_peer",
            json!({"groupId":id,"address":new_endpoint["baseUrl"]}),
        )
        .await
        .unwrap();
    assert_eq!(connected["ok"], true);
    assert_eq!(connected["state"]["messages"], before);
    let persisted: Value = serde_json::from_slice(
        &tokio::fs::read(a_dir.path().join(format!("group_{id}.json")))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(persisted["peers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["baseUrl"] == new_endpoint["baseUrl"]));
    b2.dispatch("send_text", json!({"groupId":id,"text":"直接重连后"}))
        .await
        .unwrap();
    wait_count(&a, id, 2).await;
    b2.shutdown().await;
    drop(occupied);
    let b3 = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    assert_eq!(
        bootstrap(&b3).await["endpoint"]["port"],
        new_endpoint["port"]
    );
    a.dispatch("send_text", json!({"groupId":id,"text":"固定端口再重启"}))
        .await
        .unwrap();
    wait_count(&b3, id, 3).await;
    a.shutdown().await;
    b3.shutdown().await;
}
#[tokio::test]
async fn connect_peer_rejects_unknown_device_before_sending_group_proof() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    let group = core
        .dispatch("create_group", json!({"name":"不信任地址"}))
        .await
        .unwrap();
    let id = group["id"].as_str().unwrap();
    let path = dir.path().join(format!("group_{id}.json"));
    let before = tokio::fs::read(&path).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let router=axum::Router::new().route("/api/peer/info",axum::routing::get(||async{axum::Json(json!({"protocol":"pickdrop-peer-v1","device":{"id":"ffffffff-ffff-4fff-8fff-ffffffffffff","name":"陌生设备"}}))})).route("/api/peer/sync",axum::routing::post(move||{let count=count.clone();async move{count.fetch_add(1,Ordering::Relaxed);axum::Json(json!({}))}}));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    assert!(core
        .dispatch("connect_peer", json!({"groupId":id,"address":address}))
        .await
        .is_err());
    assert_eq!(requests.load(Ordering::Relaxed), 0);
    assert_eq!(tokio::fs::read(path).await.unwrap(), before);
    core.shutdown().await;
    server.abort();
}
#[tokio::test]
async fn connect_peer_requires_signed_same_genesis_and_never_replaces_history() {
    use pickdrop_core::protocol::{s, sign, signing, Replica};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/peer-v1.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let id = fixture["genesis"]["groupId"].as_str().unwrap();
    let path = dir.path().join(format!("group_{id}.json"));
    tokio::fs::write(
        dir.path().join("identity.json"),
        json!({"privateKey":fixture["creatorIdentity"]["privateKey"],"device":fixture["device"]})
            .to_string(),
    )
    .await
    .unwrap();
    tokio::fs::write(
        &path,
        json!({"genesis":fixture["genesis"],"events":fixture["events"],"peers":[]}).to_string(),
    )
    .await
    .unwrap();
    let core = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    let before = tokio::fs::read(&path).await.unwrap();
    let previous = state(&core, id).await;
    let replica = Replica::new(
        fixture["genesis"].clone(),
        fixture["events"].as_array().unwrap().clone(),
    )
    .unwrap();
    let mut genesis = fixture["genesis"].clone();
    genesis.as_object_mut().unwrap().remove("signature");
    genesis["name"] = "伪造替换群".into();
    let forged = sign(
        genesis,
        &signing(s(&fixture["creatorIdentity"], "privateKey")).unwrap(),
    );
    let signed_wrong_genesis = replica.proof(
        "sync-result",
        json!({"genesis":forged,"events":[],"known":[]}),
        &fixture["second"],
        &signing(s(&fixture["memberIdentity"], "privateKey")).unwrap(),
    );
    let member = fixture["second"].clone();
    let tamper = Arc::new(AtomicBool::new(false));
    let mode = tamper.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let router = axum::Router::new()
        .route(
            "/api/peer/info",
            axum::routing::get(move || {
                let member = member.clone();
                async move { axum::Json(json!({"protocol":"pickdrop-peer-v1","device":member})) }
            }),
        )
        .route(
            "/api/peer/sync",
            axum::routing::post(move || {
                let mut proof = signed_wrong_genesis.clone();
                let mode = mode.clone();
                async move {
                    if mode.load(Ordering::Relaxed) {
                        proof["signature"] = "00".repeat(64).into();
                    }
                    axum::Json(proof)
                }
            }),
        );
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    assert!(core
        .dispatch("connect_peer", json!({"groupId":id,"address":address}))
        .await
        .is_err());
    tamper.store(true, Ordering::Relaxed);
    assert!(core
        .dispatch("connect_peer", json!({"groupId":id,"address":address}))
        .await
        .is_err());
    assert_eq!(state(&core, id).await["messages"], previous["messages"]);
    assert_eq!(state(&core, id).await["name"], previous["name"]);
    assert_eq!(tokio::fs::read(path).await.unwrap(), before);
    core.shutdown().await;
    server.abort();
}
