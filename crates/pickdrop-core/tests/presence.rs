use pickdrop_core::Core;
use serde_json::json;
#[tokio::test]
async fn lifecycle_changes_publish_only_presence_without_writing_history() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().to_owned(), "mobile").await.unwrap();
    let group = core
        .dispatch("create_group", json!({"name":"生命周期"}))
        .await
        .unwrap();
    let id = group["id"].as_str().unwrap();
    let path = dir.path().join(format!("group_{id}.json"));
    let before = tokio::fs::read(&path).await.unwrap();
    let modified = tokio::fs::metadata(&path)
        .await
        .unwrap()
        .modified()
        .unwrap();
    let initial = core
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap();
    let mut events = core.subscribe();
    core.dispatch("set_active", json!({"active":false}))
        .await
        .unwrap();
    let paused = events.recv().await.unwrap();
    assert_eq!(paused["type"], "state");
    assert_eq!(paused["state"]["devices"][0]["online"], false);
    assert_eq!(paused["state"]["revision"], initial["revision"]);
    assert_eq!(
        paused["state"]["presenceRevision"].as_u64().unwrap(),
        initial["presenceRevision"].as_u64().unwrap() + 1
    );
    core.dispatch("set_active", json!({"active":false}))
        .await
        .unwrap();
    assert!(events.try_recv().is_err());
    core.dispatch("set_active", json!({"active":true}))
        .await
        .unwrap();
    let resumed = events.recv().await.unwrap();
    assert_eq!(resumed["state"]["devices"][0]["online"], true);
    assert_eq!(
        resumed["state"]["presenceRevision"].as_u64().unwrap(),
        initial["presenceRevision"].as_u64().unwrap() + 2
    );
    assert_eq!(resumed["state"]["revision"], initial["revision"]);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
    assert_eq!(
        tokio::fs::metadata(&path)
            .await
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
}
