use pickdrop_core::Core;
use serde_json::json;
use std::{net::Ipv4Addr, time::Duration};

#[tokio::test]
async fn unreachable_sender_is_not_reported_as_a_missing_file_copy() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = Core::open_with_bind_address(a_dir.path().into(), "desktop", Ipv4Addr::LOCALHOST)
        .await
        .unwrap();
    let b = Core::open_with_bind_address(b_dir.path().into(), "desktop", Ipv4Addr::LOCALHOST)
        .await
        .unwrap();
    let group = a
        .dispatch("create_group", json!({"name":"文件可达性"}))
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
    let source = a_dir.path().join("payload.txt");
    std::fs::write(&source, b"sender still holds this file").unwrap();
    let message = a
        .dispatch("send_file", json!({"groupId":id,"path":source}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = b
                .dispatch("get_state", json!({"groupId":id}))
                .await
                .unwrap();
            if state["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == message["id"])
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    a.shutdown().await;
    assert!(a_dir
        .path()
        .join("files")
        .join(message["sha256"].as_str().unwrap())
        .exists());
    let error = b
        .dispatch("receive_file", json!({"groupId":id,"id":message["id"]}))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("文件接收失败"), "{error}");
    assert!(
        error.contains(invite["baseUrl"].as_str().unwrap()),
        "{error}"
    );
    assert!(!error.contains("没有在线设备持有"), "{error}");
    let restored =
        Core::open_with_bind_address(a_dir.path().into(), "desktop", Ipv4Addr::LOCALHOST)
            .await
            .unwrap();
    let saved = b
        .dispatch("receive_file", json!({"groupId":id,"id":message["id"]}))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(saved["path"].as_str().unwrap()).unwrap(),
        b"sender still holds this file"
    );
    b.shutdown().await;
    restored.shutdown().await;
}
