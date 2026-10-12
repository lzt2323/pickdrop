use pickdrop_core::Core;
use serde_json::{json, Value};
use std::time::Duration;
async fn wait_messages(core: &Core, id: &str, count: usize) -> Value {
    for _ in 0..80 {
        let state = core
            .dispatch("get_state", json!({"groupId":id}))
            .await
            .unwrap();
        if state["messages"].as_array().unwrap().len() >= count {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    panic!("message sync timed out")
}
#[tokio::test]
async fn native_nodes_pair_sync_and_stream_verified_file() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = Core::open(a_dir.path().to_owned(), "desktop")
        .await
        .unwrap();
    let b = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    let group = a
        .dispatch("create_group", json!({"name":"两端测试","animalId":"cat"}))
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
    let requests = a
        .dispatch("list_join_requests", json!({"groupId":id}))
        .await
        .unwrap();
    assert_eq!(requests.as_array().unwrap().len(), 1);
    assert!(requests[0].get("pollToken").is_none());
    a.dispatch(
        "respond_join",
        json!({"groupId":id,"id":ticket["requestId"],"allow":true}),
    )
    .await
    .unwrap();
    let accepted = b
        .dispatch("check_join", json!({"ticket":ticket}))
        .await
        .unwrap();
    assert_eq!(accepted["status"], "approved");
    a.dispatch("send_text", json!({"groupId":id,"text":"电脑到手机"}))
        .await
        .unwrap();
    assert_eq!(
        wait_messages(&b, id, 1).await["messages"][0]["text"],
        "电脑到手机"
    );
    b.dispatch("send_text", json!({"groupId":id,"text":"手机到电脑"}))
        .await
        .unwrap();
    wait_messages(&a, id, 2).await;
    let source = a_dir.path().join("original.bin");
    let contents = vec![42u8; 512 * 1024];
    tokio::fs::write(&source, &contents).await.unwrap();
    let message = a
        .dispatch("send_file", json!({"groupId":id,"path":source}))
        .await
        .unwrap();
    wait_messages(&b, id, 3).await;
    let received = b
        .dispatch("receive_file", json!({"groupId":id,"id":message["id"]}))
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read(received["path"].as_str().unwrap())
            .await
            .unwrap(),
        contents
    );
    let state = b
        .dispatch("get_state", json!({"groupId":id,"before":3,"limit":1}))
        .await
        .unwrap();
    assert_eq!(state["messages"].as_array().unwrap().len(), 1);
    assert_eq!(state["history"]["hasMore"], true);
    let bytes = tokio::fs::read(a_dir.path().join(format!("group_{id}.json")))
        .await
        .unwrap();
    let metadata = tokio::fs::metadata(a_dir.path().join(format!("group_{id}.json")))
        .await
        .unwrap()
        .modified()
        .unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(
        tokio::fs::read(a_dir.path().join(format!("group_{id}.json")))
            .await
            .unwrap(),
        bytes
    );
    assert_eq!(
        tokio::fs::metadata(a_dir.path().join(format!("group_{id}.json")))
            .await
            .unwrap()
            .modified()
            .unwrap(),
        metadata
    );
}
