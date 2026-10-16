use pickdrop_core::{protocol::*, Core};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

async fn snapshot(dir: &Path, id: &str) -> Replica {
    Replica::from_snapshot(
        &serde_json::from_slice::<Value>(
            &tokio::fs::read(dir.join(format!("group_{id}.json")))
                .await
                .unwrap(),
        )
        .unwrap(),
    )
    .unwrap()
}
async fn identity(dir: &Path) -> (Value, ed25519_dalek::SigningKey) {
    let saved: Value =
        serde_json::from_slice(&tokio::fs::read(dir.join("identity.json")).await.unwrap()).unwrap();
    (
        saved["device"].clone(),
        signing(s(&saved, "privateKey")).unwrap(),
    )
}
async fn joined(a: &Core, b: &Core) -> Value {
    let group = a
        .dispatch("create_group", json!({"name":"撤销回归"}))
        .await
        .unwrap();
    let invite = a
        .dispatch("create_invite", json!({"groupId":group["id"]}))
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
        json!({"groupId":group["id"],"id":ticket["requestId"],"allow":true}),
    )
    .await
    .unwrap();
    assert_eq!(
        b.dispatch("check_join", json!({"ticket":ticket}))
            .await
            .unwrap()["status"],
        "approved"
    );
    group
}
#[tokio::test]
async fn removed_offline_node_receives_only_its_signed_revocation_and_can_forget() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = Core::open(a_dir.path().to_owned(), "desktop")
        .await
        .unwrap();
    let b = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    let fallback = b
        .dispatch("create_group", json!({"name":"保留的本地群"}))
        .await
        .unwrap();
    let group = joined(&a, &b).await;
    let id = s(&group, "id");
    assert!(
        b.dispatch("forget_group", json!({"groupId":id}))
            .await
            .is_err(),
        "Active members must leave first"
    );
    b.dispatch("set_active", json!({"active":false}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (device, key) = identity(b_dir.path()).await;
    let mut stale = snapshot(b_dir.path(), id).await;
    // Missing ancestry contains private text, a file, and another device's grant.
    a.dispatch(
        "send_text",
        json!({"groupId":id,"text":"PRIVATE_AFTER_OFFLINE"}),
    )
    .await
    .unwrap();
    let source = a_dir.path().join("private.bin");
    tokio::fs::write(&source, b"private new file")
        .await
        .unwrap();
    let file = a
        .dispatch("send_file", json!({"groupId":id,"path":source}))
        .await
        .unwrap();
    a.dispatch(
        "remove_member",
        json!({"groupId":id,"deviceId":device["id"]}),
    )
    .await
    .unwrap();
    // The stale member can still sign a locally valid message, but the host must ignore it.
    let attempted = stale.append("message", json!({"id":uuid::Uuid::new_v4(),"type":"text","text":"REVOKED_INJECTION","senderId":device["id"],"senderName":"手机","createdAt":"2026-10-13T00:00:00Z"}), &device, &key).unwrap();
    let host = a.dispatch("bootstrap", json!({})).await.unwrap();
    let address = s(&host["endpoint"], "baseUrl");
    let proof = stale.proof("sync", json!({"genesis":stale.genesis,"events":[attempted],"known":stale.events.keys().collect::<Vec<_>>() }), &device, &key);
    let response: Value = reqwest::Client::new()
        .post(format!("{address}/api/peer/sync"))
        .json(&proof)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let payload = stale.verify_proof(&response, "sync-result", false).unwrap();
    assert_eq!(payload["events"], json!([]));
    assert_eq!(payload["known"], json!([]));
    assert_eq!(payload["peers"], json!([]));
    assert_eq!(payload["accepted"], json!([]));
    assert_eq!(payload["revocations"].as_array().unwrap().len(), 1);
    let receipt = &payload["revocations"][0];
    assert_eq!(receipt["type"], "member.remove");
    assert_eq!(receipt["payload"]["deviceId"], device["id"]);
    verify(receipt, s(&stale.genesis, "creatorPublicKey")).unwrap();
    assert!(!response.to_string().contains("PRIVATE_AFTER_OFFLINE"));
    assert!(!a
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap()
        .to_string()
        .contains("REVOKED_INJECTION"));
    // A different key claiming the old device ID must not get any signed receipt.
    let wrong_key = signing(&random(32)).unwrap();
    let forged_identity = stale.proof(
        "sync",
        json!({"genesis":stale.genesis,"events":[],"known":[]}),
        &device,
        &wrong_key,
    );
    assert!(!reqwest::Client::new()
        .post(format!("{address}/api/peer/sync"))
        .json(&forged_identity)
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    let file_proof = stale.proof("file", json!({"id":file["id"]}), &device, &key);
    assert!(!reqwest::Client::new()
        .get(format!("{address}/api/peer/files/{}", s(&file, "id")))
        .header("x-peer-proof", file_proof.to_string())
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    let mut updates = b.subscribe();
    b.dispatch("set_active", json!({"active":true}))
        .await
        .unwrap();
    b.dispatch("connect_peer", json!({"groupId":id,"address":address}))
        .await
        .unwrap();
    let state = b
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap();
    assert_eq!(state["membershipRevoked"], true);
    assert!(!state.to_string().contains("PRIVATE_AFTER_OFFLINE"));
    let mut published = false;
    while let Ok(event) = updates.try_recv() {
        published |= event["state"]["membershipRevoked"] == true;
    }
    assert!(published, "UI must receive the persisted revoked state");
    assert!(b
        .dispatch("send_text", json!({"groupId":id,"text":"blocked"}))
        .await
        .is_err());
    assert!(b
        .dispatch("create_invite", json!({"groupId":id}))
        .await
        .is_err());
    assert!(b
        .dispatch("receive_file", json!({"groupId":id,"id":file["id"]}))
        .await
        .is_err());
    b.shutdown().await;
    let restarted = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    assert_eq!(
        restarted
            .dispatch("get_state", json!({"groupId":id}))
            .await
            .unwrap()["membershipRevoked"],
        true
    );
    assert!(restarted
        .dispatch("send_text", json!({"groupId":id,"text":"restart blocked"}))
        .await
        .is_err());
    restarted
        .dispatch("forget_group", json!({"groupId":id}))
        .await
        .unwrap();
    assert!(
        !restarted.dispatch("bootstrap", json!({})).await.unwrap()["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| s(group, "id") == id)
    );
    assert_eq!(
        restarted.dispatch("bootstrap", json!({})).await.unwrap()["activeGroupId"],
        fallback["id"]
    );
    assert!(restarted
        .dispatch("select_group", json!({"id":id}))
        .await
        .is_err());
    restarted.shutdown().await;
    let rebooted = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    assert_eq!(
        rebooted.dispatch("bootstrap", json!({})).await.unwrap()["activeGroupId"],
        fallback["id"]
    );
    assert!(rebooted
        .dispatch("select_group", json!({"id":id}))
        .await
        .is_err());
    rebooted.shutdown().await;
    a.shutdown().await;
}

#[test]
fn targeted_receipts_reject_forgery_and_do_not_override_verified_rejoin() {
    let f: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/peer-v1.json")).unwrap();
    let key = signing(s(&f["creatorIdentity"], "privateKey")).unwrap();
    let member_key = signing(s(&f["memberIdentity"], "privateKey")).unwrap();
    let device = &f["device"];
    let member = &f["second"];
    let target = s(member, "id");
    let mut owner = Replica::new(
        f["genesis"].clone(),
        f["events"].as_array().unwrap().clone(),
    )
    .unwrap();
    let mut remote = owner.clone();
    owner.append("message", json!({"id":uuid::Uuid::new_v4(),"type":"text","text":"private ancestry","senderId":device["id"],"senderName":"电脑","createdAt":"2026-10-13T00:00:00Z"}), device, &key).unwrap();
    let removal = owner
        .append("member.remove", json!({"deviceId":target}), device, &key)
        .unwrap();
    let original = remote.snapshot();
    let mut forged = removal.clone();
    forged["signature"] = "00".repeat(64).into();
    forged.as_object_mut().unwrap().remove("eventId");
    forged["eventId"] = hash(&forged).into();
    assert!(remote.accept_revocation(forged, target).is_err());
    let mut wrong_group = removal.clone();
    wrong_group["groupId"] = uuid::Uuid::new_v4().to_string().into();
    assert!(remote.accept_revocation(wrong_group, target).is_err());
    assert!(remote
        .accept_revocation(removal.clone(), s(device, "id"))
        .is_err());
    assert_eq!(remote.snapshot(), original);
    assert_eq!(
        remote.accept_revocation(removal.clone(), target).unwrap(),
        1
    );
    assert!(!remote.member(target, &hex::encode(member_key.verifying_key().to_bytes())));
    assert!(remote.append("member.add", json!({"id":target,"name":"手机","publicKey":hex::encode(member_key.verifying_key().to_bytes())}), member, &member_key).is_err());
    assert_eq!(
        remote.accept_revocation(removal.clone(), target).unwrap(),
        0
    );
    let restored = Replica::from_snapshot(&remote.snapshot()).unwrap();
    assert!(!restored.member(target, &hex::encode(member_key.verifying_key().to_bytes())));
    let mut grant = member.clone();
    grant["publicKey"] = hex::encode(member_key.verifying_key().to_bytes()).into();
    owner.append("member.add", grant, device, &key).unwrap();
    // Valid missing historical events can still be authenticated despite the receipt overlay.
    remote
        .merge(owner.ordered(None).into_iter().cloned().collect())
        .unwrap();
    assert!(remote.member(target, &hex::encode(member_key.verifying_key().to_bytes())));
    assert_eq!(remote.accept_revocation(removal, target).unwrap(), 0);
    assert!(remote.member(target, &hex::encode(member_key.verifying_key().to_bytes())));
    assert!(Replica::from_snapshot(&remote.snapshot())
        .unwrap()
        .member(target, &hex::encode(member_key.verifying_key().to_bytes())));
}

#[tokio::test]
async fn forget_keeps_active_guard_and_accepts_left_or_signed_dissolved_groups() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    let left = core
        .dispatch("create_group", json!({"name":"已离开"}))
        .await
        .unwrap();
    assert!(core
        .dispatch("forget_group", json!({"groupId":left["id"]}))
        .await
        .is_err());
    core.dispatch("leave_group", json!({"groupId":left["id"]}))
        .await
        .unwrap();
    core.dispatch("forget_group", json!({"groupId":left["id"]}))
        .await
        .unwrap();
    assert!(core.dispatch("bootstrap", json!({})).await.unwrap()["activeGroupId"].is_null());
    assert!(core
        .dispatch("select_group", json!({"id":left["id"]}))
        .await
        .is_err());
    let dissolved = core
        .dispatch("create_group", json!({"name":"已解散"}))
        .await
        .unwrap();
    core.shutdown().await;
    // Legacy peers can produce the supported signed dissolve event even though this UI has no button.
    let (device, key) = identity(dir.path()).await;
    let id = s(&dissolved, "id");
    let path = dir.path().join(format!("group_{id}.json"));
    let mut saved: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    let mut replica = Replica::from_snapshot(&saved).unwrap();
    replica
        .append("dissolve", json!({}), &device, &key)
        .unwrap();
    saved["events"] = replica.snapshot()["events"].clone();
    tokio::fs::write(&path, serde_json::to_vec(&saved).unwrap())
        .await
        .unwrap();
    let restarted = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    assert_eq!(
        restarted
            .dispatch("get_state", json!({"groupId":id}))
            .await
            .unwrap()["dissolved"],
        true
    );
    restarted
        .dispatch("forget_group", json!({"groupId":id}))
        .await
        .unwrap();
    assert!(
        restarted.dispatch("bootstrap", json!({})).await.unwrap()["groups"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(restarted.dispatch("bootstrap", json!({})).await.unwrap()["activeGroupId"].is_null());
    assert!(restarted
        .dispatch("select_group", json!({"id":id}))
        .await
        .is_err());
    restarted.shutdown().await;
    let rebooted = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    assert!(rebooted.dispatch("bootstrap", json!({})).await.unwrap()["activeGroupId"].is_null());
    assert!(rebooted.dispatch("get_state", json!({})).await.is_err());
    rebooted.shutdown().await;
    // Recover a stale settings file left by an earlier version without reviving hidden groups.
    tokio::fs::write(
        dir.path().join("settings.json"),
        json!({"activeGroupId":id}).to_string(),
    )
    .await
    .unwrap();
    let recovered = Core::open(dir.path().to_owned(), "desktop").await.unwrap();
    assert!(recovered.dispatch("bootstrap", json!({})).await.unwrap()["activeGroupId"].is_null());
    assert!(recovered
        .dispatch("select_group", json!({"id":id}))
        .await
        .is_err());
    let settings: Value = serde_json::from_slice(
        &tokio::fs::read(dir.path().join("settings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(settings["activeGroupId"].is_null());
    recovered.shutdown().await;
}

#[tokio::test]
async fn a_new_identity_can_forward_its_signed_admission_from_another_member() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let c_dir = tempfile::tempdir().unwrap();
    let a = Core::open(a_dir.path().to_owned(), "desktop")
        .await
        .unwrap();
    let b = Core::open(b_dir.path().to_owned(), "mobile").await.unwrap();
    let c = Core::open(c_dir.path().to_owned(), "mobile").await.unwrap();
    let group = joined(&a, &b).await;
    let id = s(&group, "id");
    a.dispatch("set_active", json!({"active":false}))
        .await
        .unwrap();
    let invite = b
        .dispatch("create_invite", json!({"groupId":id}))
        .await
        .unwrap();
    let ticket = c
        .dispatch(
            "join_group",
            json!({"address":invite["baseUrl"],"code":invite["code"]}),
        )
        .await
        .unwrap();
    b.dispatch(
        "respond_join",
        json!({"groupId":id,"id":ticket["requestId"],"allow":true}),
    )
    .await
    .unwrap();
    assert_eq!(
        c.dispatch("check_join", json!({"ticket":ticket}))
            .await
            .unwrap()["status"],
        "approved"
    );
    // No background route can deliver C's grant before its explicit request.
    b.dispatch("set_active", json!({"active":false}))
        .await
        .unwrap();
    c.dispatch("set_active", json!({"active":false}))
        .await
        .unwrap();
    let (device, key) = identity(c_dir.path()).await;
    assert!(!a
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap()["devices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|member| member["id"] == device["id"]));
    let replica = snapshot(c_dir.path(), id).await;
    let proof = replica.proof("sync", json!({"genesis":replica.genesis,"events":replica.ordered(None),"known":replica.events.keys().collect::<Vec<_>>()}), &device, &key);
    a.dispatch("set_active", json!({"active":true}))
        .await
        .unwrap();
    let host = a.dispatch("bootstrap", json!({})).await.unwrap();
    let response = reqwest::Client::new()
        .post(format!("{}/api/peer/sync", s(&host["endpoint"], "baseUrl")))
        .json(&proof)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "A valid new signed admission must remain supported"
    );
    assert!(a
        .dispatch("get_state", json!({"groupId":id}))
        .await
        .unwrap()["devices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|member| member["id"] == device["id"]));
    a.shutdown().await;
    b.shutdown().await;
    c.shutdown().await;
}
