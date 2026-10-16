use pickdrop_core::Core;
use serde_json::{json, Value};
#[tokio::test]
async fn native_discovery_hints_are_bounded_validated_and_do_not_authorize_peer() {
    let f: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/peer-v1.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("identity.json"),
        json!({"privateKey":f["creatorIdentity"]["privateKey"],"device":f["device"]}).to_string(),
    )
    .await
    .unwrap();
    let id = f["genesis"]["groupId"].as_str().unwrap();
    let path = dir.path().join(format!("group_{id}.json"));
    tokio::fs::write(
        &path,
        json!({"genesis":f["genesis"],"events":f["events"],"peers":[]}).to_string(),
    )
    .await
    .unwrap();
    let core = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    let initial = core
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap();
    let persisted = tokio::fs::read(&path).await.unwrap();
    let record = json!({"groupId":id,"hostDeviceId":f["second"]["id"],"peerProtocol":"pickdrop-peer-v1","baseUrl":"http://127.0.0.1:9"});
    let admitted = core
        .dispatch("remember_discovery", json!({"records":[record]}))
        .await
        .unwrap();
    assert_eq!(admitted["accepted"], 1);
    for bad in [
        json!({"peerProtocol":"fake"}),
        json!({"baseUrl":"http://user:password@127.0.0.1:9"}),
        json!({"baseUrl":"http://127.0.0.1:9/path"}),
        json!({"baseUrl":"http://127.0.0.1:9?token=abc"}),
        json!({"baseUrl":"file:///tmp/a"}),
        json!({"hostDeviceId":"bad-id"}),
    ] {
        let mut value = record.clone();
        for (key, v) in bad.as_object().unwrap() {
            value[key] = v.clone();
        }
        assert!(core
            .dispatch("remember_discovery", json!({"records":[value]}))
            .await
            .is_err());
    }
    let mut unknown = record.clone();
    unknown["groupId"] = "ffffffff-ffff-4fff-8fff-ffffffffffff".into();
    assert_eq!(
        core.dispatch("remember_discovery", json!({"records":[unknown.clone()]}))
            .await
            .unwrap()["accepted"],
        0
    );
    let discovered = core.dispatch("discover_groups", json!({})).await.unwrap();
    assert!(discovered
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["groupId"] == unknown["groupId"]));
    let mut unknown = record.clone();
    unknown["hostDeviceId"] = "ffffffff-ffff-4fff-8fff-ffffffffffff".into();
    assert_eq!(
        core.dispatch("remember_discovery", json!({"records":[unknown]}))
            .await
            .unwrap()["accepted"],
        0
    );
    assert!(core
        .dispatch(
            "remember_discovery",
            json!({"records":vec![record.clone();129]})
        )
        .await
        .is_err());
    for port in 10000..10100 {
        let mut record = record.clone();
        record["baseUrl"] = format!("http://127.0.0.1:{port}").into();
        core.dispatch("remember_discovery", json!({"records":[record]}))
            .await
            .unwrap();
    }
    let state = core
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap();
    assert_eq!(state["revision"], initial["revision"]);
    assert_eq!(state["presenceRevision"], initial["presenceRevision"]);
    assert!(!state["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == f["second"]["id"])
        .unwrap()["online"]
        .as_bool()
        .unwrap());
    assert_eq!(tokio::fs::read(&path).await.unwrap(), persisted);
    let full_record = {
        let mut r = record;
        r["baseUrl"] = "http://127.0.0.1:20000".into();
        r
    };
    assert_eq!(
        core.dispatch("remember_discovery", json!({"records":[full_record]}))
            .await
            .unwrap()["accepted"],
        0
    );
}
