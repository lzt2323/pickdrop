use pickdrop_core::Core;
use serde_json::{json, Value};
#[tokio::test]
async fn legacy_desktop_import_keeps_identity_and_source_untouched() {
    let f: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/peer-v1.json")).unwrap();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("old");
    let destination = root.path().join("new");
    let id = f["genesis"]["groupId"].as_str().unwrap();
    tokio::fs::create_dir_all(
        source
            .join("groups")
            .join(id)
            .join("files")
            .join(f["events"][2]["payload"]["id"].as_str().unwrap()),
    )
    .await
    .unwrap();
    let groups = json!({"device":f["device"],"groups":[{"id":id,"mode":"peer"}]});
    let snapshot = json!({"genesis":f["genesis"],"events":f["events"],"peers":[]});
    tokio::fs::write(source.join("groups.json"), groups.to_string())
        .await
        .unwrap();
    tokio::fs::write(
        source.join("peer-identity.json"),
        f["creatorIdentity"].to_string(),
    )
    .await
    .unwrap();
    let peer_file = source.join("groups").join(id).join("peer.json");
    let original = snapshot.to_string();
    tokio::fs::write(&peer_file, &original).await.unwrap();
    tokio::fs::write(
        source
            .join("groups")
            .join(id)
            .join("files")
            .join(f["events"][2]["payload"]["id"].as_str().unwrap())
            .join("测试.txt"),
        b"abc",
    )
    .await
    .unwrap();
    let report = Core::import_legacy_desktop(source.clone(), destination.clone())
        .await
        .unwrap();
    assert_eq!(report["groups"], 1);
    assert_eq!(report["files"], 1);
    assert_eq!(
        tokio::fs::read_to_string(peer_file).await.unwrap(),
        original
    );
    let core = Core::open(destination.clone(), "desktop").await.unwrap();
    let bootstrap = core.dispatch("bootstrap", json!({})).await.unwrap();
    assert_eq!(bootstrap["device"], f["device"]);
    let state = core
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap();
    assert_eq!(state["messages"].as_array().unwrap().len(), 2);
    assert!(Core::import_legacy_desktop(source, destination)
        .await
        .is_err());
}
