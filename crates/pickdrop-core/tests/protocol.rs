use pickdrop_core::protocol::*;
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/peer-v1.json")).unwrap()
}
#[test]
fn javascript_signed_fixture_is_compatible() {
    let f = fixture();
    let r = Replica::new(
        f["genesis"].clone(),
        f["events"].as_array().unwrap().clone(),
    )
    .unwrap();
    assert_eq!(r.state, f["expectedState"]);
    verify(&f["proof"], s(&f["proof"], "senderPublicKey")).unwrap();
    verify(&f["joinProof"], s(&f["joinProof"], "publicKey")).unwrap();
    let mut body = f["proof"].clone();
    body.as_object_mut().unwrap().remove("signature");
    assert_eq!(canonical(&body), s(&f, "canonicalProofBody"));
}
#[test]
fn no_change_does_not_reverify_history() {
    let f = fixture();
    let mut r = Replica::new(
        f["genesis"].clone(),
        f["events"].as_array().unwrap().clone(),
    )
    .unwrap();
    let key = signing(s(&f["creatorIdentity"], "privateKey")).unwrap();
    for i in 0..1000 {
        r.append("message",json!({"id":uuid::Uuid::new_v4(),"type":"text","text":format!("message {i}"),"senderId":f["device"]["id"],"senderName":"电脑","createdAt":"2026-10-12T08:00:00Z"}),&f["device"],&key).unwrap();
    }
    let validations = r.validations;
    let revision = r.revision;
    let now = std::time::Instant::now();
    for _ in 0..100 {
        assert_eq!(r.merge(vec![]).unwrap(), 0)
    }
    println!("100 empty syncs with 1004 historical events: {:?}; signature validations unchanged at {validations}",now.elapsed());
    assert_eq!(r.validations, validations);
    assert_eq!(r.revision, revision);
    assert_eq!(r.merge(f["events"].as_array().unwrap().clone()).unwrap(), 0);
    assert_eq!(r.validations, validations);
}
#[test]
fn invalid_batch_rolls_back() {
    let f = fixture();
    let mut r = Replica::new(f["genesis"].clone(), vec![]).unwrap();
    let mut events = f["events"].as_array().unwrap().clone();
    events[1]["payload"]["text"] = "forged".into();
    assert!(r.merge(events).is_err());
    assert!(r.events.is_empty());
    assert!(r.heads.is_empty());
}
#[test]
fn javascript_concurrent_and_permission_cases_match() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/peer-v1-cases.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let r = Replica::new(
            case["genesis"].clone(),
            case["events"].as_array().unwrap().clone(),
        )
        .unwrap();
        assert_eq!(r.state, case["expectedState"], "case {}", case["name"]);
    }
    for case in fixture["rejected"].as_array().unwrap() {
        let mut r = Replica::new(
            case["genesis"].clone(),
            case["events"].as_array().unwrap().clone(),
        )
        .unwrap();
        let snapshot = r.snapshot();
        assert!(
            r.merge(vec![case["rejectedEvent"].clone()]).is_err(),
            "forbidden case {}",
            case["name"]
        );
        assert_eq!(r.snapshot(), snapshot);
    }
}
