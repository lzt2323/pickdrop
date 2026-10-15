use pickdrop_core::Core;
use serde_json::json;
use std::net::Ipv4Addr;

#[tokio::test]
async fn explicit_loopback_binding_remains_private_after_network_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open_with_bind_address(dir.path().into(), "desktop", Ipv4Addr::LOCALHOST)
        .await
        .unwrap();
    let boot = core.dispatch("bootstrap", json!({})).await.unwrap();
    let endpoint = boot["endpoint"]["baseUrl"].as_str().unwrap();
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    assert!(reqwest::get(format!("{endpoint}/api/peer/info"))
        .await
        .is_ok());
    tokio::time::sleep(std::time::Duration::from_millis(4200)).await;
    assert_eq!(
        core.dispatch("bootstrap", json!({})).await.unwrap()["endpoint"],
        boot["endpoint"]
    );
    core.shutdown().await;
    let restored = Core::open_with_bind_address(dir.path().into(), "desktop", Ipv4Addr::LOCALHOST)
        .await
        .unwrap();
    assert_eq!(
        restored.dispatch("bootstrap", json!({})).await.unwrap()["endpoint"],
        boot["endpoint"]
    );
    restored.shutdown().await;
}

#[tokio::test]
async fn invalid_local_binding_returns_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Core::open_with_bind_address(
        dir.path().into(),
        "desktop",
        Ipv4Addr::new(192, 0, 2, 123)
    )
    .await
    .is_err());
}
