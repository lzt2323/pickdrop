use pickdrop_core::{
    protocol::{s, verify},
    Core,
};
use serde_json::{json, Value};
use std::time::Duration;
#[tokio::test]
async fn cancelled_native_send_removes_partial_and_never_appends_message() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("data"), "desktop")
        .await
        .unwrap();
    let group = core
        .dispatch("create_group", json!({"name":"取消测试"}))
        .await
        .unwrap();
    let file = dir.path().join("large.bin");
    tokio::fs::File::create(&file)
        .await
        .unwrap()
        .set_len(512 * 1024 * 1024)
        .await
        .unwrap();
    let mut events = core.subscribe();
    let sender = core.clone();
    let group_id = group["id"].clone();
    let job = tokio::spawn(async move {
        sender
            .dispatch(
                "send_file",
                json!({"groupId":group_id,"path":file,"transferId":"cancel-send"}),
            )
            .await
    });
    loop {
        let e = events.recv().await.unwrap();
        if e["id"] == "cancel-send" && e["status"] == "sending" {
            break;
        }
    }
    assert_eq!(
        core.dispatch("cancel_transfer", json!({"transferId":"cancel-send"}))
            .await
            .unwrap()["ok"],
        true
    );
    assert!(job.await.unwrap().is_err());
    let state = core
        .dispatch("get_state", json!({"groupId":group["id"]}))
        .await
        .unwrap();
    assert!(state["messages"].as_array().unwrap().is_empty());
    assert_eq!(
        core.dispatch("cancel_transfer", json!({"transferId":"cancel-send"}))
            .await
            .unwrap()["ok"],
        false
    );
    let mut files = tokio::fs::read_dir(dir.path().join("data/files"))
        .await
        .unwrap();
    while let Some(f) = files.next_entry().await.unwrap() {
        assert!(!f.file_name().to_string_lossy().ends_with(".part"));
    }
}
#[tokio::test]
async fn cancelled_native_receive_interrupts_waiting_stream_and_removes_partial() {
    let f: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/peer-v1.json")).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = axum::Router::new().route(
        "/api/peer/files/{id}",
        axum::routing::get(|headers: axum::http::HeaderMap| async move {
            let proof: Value =
                serde_json::from_str(headers["x-peer-proof"].to_str().unwrap()).unwrap();
            verify(&proof, s(&proof, "senderPublicKey")).unwrap();
            let stream = futures_util::stream::once(async {
                tokio::time::sleep(Duration::from_secs(3)).await;
                Ok::<_, std::io::Error>("abc")
            });
            axum::body::Body::from_stream(stream)
        }),
    );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("identity.json"),
        json!({"privateKey":f["memberIdentity"]["privateKey"],"device":f["second"]}).to_string(),
    )
    .await
    .unwrap();
    let group = f["genesis"]["groupId"].as_str().unwrap();
    tokio::fs::write(dir.path().join(format!("group_{group}.json")),json!({"genesis":f["genesis"],"events":f["events"],"peers":[{"baseUrl":base,"deviceId":f["device"]["id"]}]}).to_string()).await.unwrap();
    let core = Core::open(dir.path().to_owned(), "mobile").await.unwrap();
    let receiver = core.clone();
    let group = group.to_string();
    let job = tokio::spawn(async move {
        receiver.dispatch("receive_file",json!({"groupId":group,"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","transferId":"cancel-receive"})).await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let start = std::time::Instant::now();
    assert_eq!(
        core.dispatch("cancel_transfer", json!({"transferId":"cancel-receive"}))
            .await
            .unwrap()["ok"],
        true
    );
    assert!(job.await.unwrap().is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
    let mut files = tokio::fs::read_dir(dir.path().join("files")).await.unwrap();
    while let Some(f) = files.next_entry().await.unwrap() {
        assert!(!f.file_name().to_string_lossy().ends_with(".part"));
    }
}
