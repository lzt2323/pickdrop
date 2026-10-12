//! Android system NSD callbacks go directly to Rust route hints. No JavaScript
//! network processing or trust is involved; signed HTTP still verifies peers.
use super::Host;
use serde_json::{json, Value};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Manager,
};

pub fn launch(app: tauri::AppHandle) {
    let core = app.state::<Host>().core.clone();
    let routing = core.clone();
    let channel: Channel<Value> = Channel::new(move |body| {
        let value = match body {
            InvokeResponseBody::Json(value) => serde_json::from_str::<Value>(&value).ok(),
            InvokeResponseBody::Raw(value) => serde_json::from_slice::<Value>(&value).ok(),
        };
        if let Some(value) = value {
            let core = routing.clone();
            tauri::async_runtime::spawn(async move {
                let _ = core.dispatch("remember_discovery", value).await;
            });
        }
        Ok(())
    });
    let mut events = core.subscribe();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        loop {
            // Reconfigure only the small advertisement projection. Native skips
            // unchanged groups/port/network; its lifecycle owns stop/resume.
            if let Ok(state) = core.dispatch("bootstrap", json!({})).await {
                let groups = state["groups"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|group| !matches!(group["role"].as_str(), Some("removed" | "left")))
                    .take(32)
                    .map(|group| json!({"id":group["id"],"name":group["name"]}))
                    .collect::<Vec<_>>();
                let args = json!({"port":state["endpoint"]["port"],"deviceId":state["endpoint"]["deviceId"],"baseUrl":state["endpoint"]["baseUrl"],"groups":groups,"events":channel});
                let handle = app.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    handle
                        .state::<tauri_plugin_pickdrop_native::Native<tauri::Wry>>()
                        .call("configureDiscovery", args)
                })
                .await;
            }
            loop {
                tokio::select! {
                    _=interval.tick()=>break,
                    event=events.recv()=>match event {
                        Ok(event) if matches!(event["type"].as_str(),Some("groups"|"endpoint"))=>break,
                        Ok(_)=>{},
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>break,
                        Err(_)=>return,
                    }
                }
            }
        }
    });
}
