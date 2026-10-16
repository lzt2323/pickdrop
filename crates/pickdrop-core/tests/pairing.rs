use pickdrop_core::Core;
use serde_json::json;

#[tokio::test]
async fn denied_join_stays_unadmitted_and_cannot_be_decided_again() {
    let host_directory = tempfile::tempdir().unwrap();
    let guest_directory = tempfile::tempdir().unwrap();
    let host = Core::open(host_directory.path().to_owned(), "desktop")
        .await
        .unwrap();
    let guest = Core::open(guest_directory.path().to_owned(), "mobile")
        .await
        .unwrap();
    let group = host
        .dispatch("create_group", json!({"name":"Admission decisions"}))
        .await
        .unwrap();
    let group_id = group["id"].as_str().unwrap();
    let invite = host
        .dispatch("create_invite", json!({"groupId":group_id}))
        .await
        .unwrap();
    let ticket = guest
        .dispatch(
            "join_group",
            json!({"address":invite["baseUrl"],"code":invite["code"]}),
        )
        .await
        .unwrap();
    let pending = guest
        .dispatch("check_join", json!({"ticket":ticket}))
        .await
        .unwrap();
    assert_eq!(pending["status"], "pending");

    // A malformed decision must not consume or approve the pending request.
    let invalid = host
        .dispatch(
            "respond_join",
            json!({"groupId":group_id,"id":ticket["requestId"],"allow":"yes"}),
        )
        .await;
    assert!(invalid
        .unwrap_err()
        .to_string()
        .contains("Invalid decision"));
    let requests = host
        .dispatch("list_join_requests", json!({"groupId":group_id}))
        .await
        .unwrap();
    assert_eq!(requests.as_array().unwrap().len(), 1);
    assert_eq!(requests[0]["id"], ticket["requestId"]);
    assert!(requests[0].get("pollToken").is_none());

    let denied = host
        .dispatch(
            "respond_join",
            json!({"groupId":group_id,"id":ticket["requestId"],"allow":false}),
        )
        .await
        .unwrap();
    assert_eq!(denied["status"], "denied");
    assert_eq!(
        guest
            .dispatch("check_join", json!({"ticket":ticket}))
            .await
            .unwrap()["status"],
        "denied"
    );
    assert!(host
        .dispatch("list_join_requests", json!({"groupId":group_id}))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert!(guest
        .dispatch("list_groups", json!({}))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let retry = host
        .dispatch(
            "respond_join",
            json!({"groupId":group_id,"id":ticket["requestId"],"allow":true}),
        )
        .await;
    assert!(retry
        .unwrap_err()
        .to_string()
        .contains("申请已过期或已处理"));
    let state = host
        .dispatch("get_state", json!({"groupId":group_id}))
        .await
        .unwrap();
    assert_eq!(state["devices"].as_array().unwrap().len(), 1);
    guest.shutdown().await;
    host.shutdown().await;
}

#[tokio::test]
async fn approved_join_completes_without_the_waiting_panel() {
    let host_directory = tempfile::tempdir().unwrap();
    let guest_directory = tempfile::tempdir().unwrap();
    let host = Core::open(host_directory.path().to_owned(), "desktop")
        .await
        .unwrap();
    let guest = Core::open(guest_directory.path().to_owned(), "mobile")
        .await
        .unwrap();
    let group = host
        .dispatch("create_group", json!({"name":"Background admission"}))
        .await
        .unwrap();
    let group_id = group["id"].as_str().unwrap();
    let invite = host
        .dispatch("create_invite", json!({"groupId":group_id}))
        .await
        .unwrap();
    let ticket = guest
        .dispatch(
            "join_group",
            json!({"address":invite["baseUrl"],"code":invite["code"]}),
        )
        .await
        .unwrap();
    // Closing the waiting panel stops frontend check_join calls. Approval must
    // still complete on the device that submitted the signed request.
    host.dispatch(
        "respond_join",
        json!({"groupId":group_id,"id":ticket["requestId"],"allow":true}),
    )
    .await
    .unwrap();
    let admitted = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let groups = guest.dispatch("list_groups", json!({})).await.unwrap();
            if groups
                .as_array()
                .unwrap()
                .iter()
                .any(|group| group["id"] == group_id)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await;
    guest.shutdown().await;
    host.shutdown().await;
    assert!(
        admitted.is_ok(),
        "approved request was lost when frontend polling stopped"
    );
}

#[tokio::test]
async fn pending_join_survives_requester_restart_and_connects_without_manual_polling() {
    let host_directory = tempfile::tempdir().unwrap();
    let guest_directory = tempfile::tempdir().unwrap();
    let host = Core::open(host_directory.path().to_owned(), "desktop")
        .await
        .unwrap();
    let guest = Core::open(guest_directory.path().to_owned(), "mobile")
        .await
        .unwrap();
    let group = host
        .dispatch("create_group", json!({"name":"Restart admission"}))
        .await
        .unwrap();
    let group_id = group["id"].as_str().unwrap();
    let invite = host
        .dispatch("create_invite", json!({"groupId":group_id}))
        .await
        .unwrap();
    let ticket = guest
        .dispatch(
            "join_group",
            json!({"address":invite["baseUrl"],"code":invite["code"]}),
        )
        .await
        .unwrap();
    guest.shutdown().await;
    host.dispatch(
        "respond_join",
        json!({"groupId":group_id,"id":ticket["requestId"],"allow":true}),
    )
    .await
    .unwrap();
    let guest = Core::open(guest_directory.path().to_owned(), "mobile")
        .await
        .unwrap();
    let host_id = host.dispatch("bootstrap", json!({})).await.unwrap()["device"]["id"].clone();
    let guest_id = guest.dispatch("bootstrap", json!({})).await.unwrap()["device"]["id"].clone();
    tokio::time::timeout(std::time::Duration::from_secs(12), async {
        loop {
            let guest_state = guest
                .dispatch("get_state", json!({"groupId":group_id}))
                .await;
            let host_state = host
                .dispatch("get_state", json!({"groupId":group_id}))
                .await
                .unwrap();
            if guest_state.is_ok_and(|state| {
                state["devices"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|d| d["id"] == host_id && d["online"] == true)
            }) && host_state["devices"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["id"] == guest_id && d["online"] == true)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("both devices should become online without frontend polling");
    let pending: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(guest_directory.path().join("pending-joins.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(pending, json!({}));
    guest.shutdown().await;
    host.shutdown().await;
}

#[tokio::test]
async fn repeated_approval_poll_preserves_new_messages_and_active_selection() {
    let host_directory = tempfile::tempdir().unwrap();
    let guest_directory = tempfile::tempdir().unwrap();
    let host = Core::open(host_directory.path().to_owned(), "desktop")
        .await
        .unwrap();
    let guest = Core::open(guest_directory.path().to_owned(), "mobile")
        .await
        .unwrap();
    let group = host
        .dispatch("create_group", json!({"name":"Idempotent admission"}))
        .await
        .unwrap();
    let group_id = group["id"].as_str().unwrap();
    let invite = host
        .dispatch("create_invite", json!({"groupId":group_id}))
        .await
        .unwrap();
    let ticket = guest
        .dispatch(
            "join_group",
            json!({"address":invite["baseUrl"],"code":invite["code"]}),
        )
        .await
        .unwrap();
    host.dispatch(
        "respond_join",
        json!({"groupId":group_id,"id":ticket["requestId"],"allow":true}),
    )
    .await
    .unwrap();
    guest
        .dispatch("check_join", json!({"ticket":ticket}))
        .await
        .unwrap();
    guest
        .dispatch(
            "send_text",
            json!({"groupId":group_id,"text":"Keep after approval"}),
        )
        .await
        .unwrap();
    let other = guest
        .dispatch("create_group", json!({"name":"Keep selection"}))
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        guest.dispatch("check_join", json!({"ticket":ticket})),
        guest.dispatch("check_join", json!({"ticket":ticket}))
    );
    first.unwrap();
    second.unwrap();
    let state = guest
        .dispatch("get_state", json!({"groupId":group_id}))
        .await
        .unwrap();
    assert_eq!(state["messages"].as_array().unwrap().len(), 1);
    assert_eq!(state["messages"][0]["text"], "Keep after approval");
    assert_eq!(
        guest.dispatch("bootstrap", json!({})).await.unwrap()["activeGroupId"],
        other["id"]
    );
    guest.shutdown().await;
    host.shutdown().await;
}
