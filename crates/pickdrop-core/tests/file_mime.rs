use pickdrop_core::{
    protocol::{hash, s, verify},
    Core,
};
use serde_json::{json, Value};
#[tokio::test]
async fn native_png_message_preserves_mime_and_valid_signed_event() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("data"), "desktop")
        .await
        .unwrap();
    let group = core
        .dispatch("create_group", json!({"name":"图片兼容"}))
        .await
        .unwrap();
    let image = dir.path().join("Preview.PNG");
    let png=hex::decode("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082").unwrap();
    tokio::fs::write(&image, &png).await.unwrap();
    let message = core
        .dispatch("send_file", json!({"groupId":group["id"],"path":image}))
        .await
        .unwrap();
    assert_eq!(message["mime"], "image/png");
    let snapshot: Value = serde_json::from_slice(
        &tokio::fs::read(
            dir.path()
                .join("data")
                .join(format!("group_{}.json", group["id"].as_str().unwrap())),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let event = &snapshot["events"][0];
    assert_eq!(event["payload"], message);
    verify(event, s(event, "authorPublicKey")).unwrap();
    let mut signed = event.clone();
    signed.as_object_mut().unwrap().remove("eventId");
    assert_eq!(hash(&signed), s(event, "eventId"));
    let received = core
        .dispatch(
            "receive_file",
            json!({"groupId":group["id"],"id":message["id"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read(received["path"].as_str().unwrap())
            .await
            .unwrap(),
        png
    );
}
