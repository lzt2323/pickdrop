//! Opt-in debug smoke exercises actual native window APIs in the desktop session.
//! Uses an isolated data directory and exits; never compiled into release builds.
use serde_json::json;
use tauri::{Emitter, Manager};
pub fn launch(app: tauri::AppHandle, report: std::path::PathBuf) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        let result: Result<(), String> = async {
            let window = app.get_webview_window("main").ok_or("main window absent")?;
            super::docking::action(&window, "pin", Some(true))?;
            if !window.is_always_on_top().map_err(|e| e.to_string())? {
                return Err("pin failed".into());
            }
            super::docking::action(&window, "pin", Some(false))?;
            super::docking::action(&window, "dock-right", None)?;
            window.hide().map_err(|e| e.to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            super::docking::action(&window, "collapse", None)?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let size = window.inner_size().map_err(|e| e.to_string())?;
            if size.width > 160 || size.height > 240 {
                return Err(format!("collapse failed: {size:?}"));
            }
            super::docking::action(&window, "expand", None)?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let size = window.inner_size().map_err(|e| e.to_string())?;
            if size.width < 300 || size.height < 300 {
                return Err(format!("expand failed: {size:?}"));
            }
            window.hide().map_err(|e| e.to_string())?;
            if window.is_visible().map_err(|e| e.to_string())? {
                return Err("hide failed".into());
            }
            window.show().map_err(|e| e.to_string())?;
            if !window.is_visible().map_err(|e| e.to_string())? {
                return Err("show failed".into());
            }
            super::window_action(window.clone(), "new".into(), None).await?;
            if app.webview_windows().len() != 2 {
                return Err("new window failed".into());
            }
            let state = app
                .state::<super::Host>()
                .core
                .dispatch("bootstrap", json!({}))
                .await
                .map_err(|e| e.to_string())?;
            if state.get("device").is_none() {
                return Err("native core bootstrap failed".into());
            }
            app.emit("pickdrop:event", json!({"type":"smoke"}))
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        let passed = result.is_ok();
        let payload = json!({"passed":passed,"error":result.err(),"checks":["core bootstrap","pin/unpin","edge collapse/expand","hide/show","multiwindow","native event emission"],"platform":std::env::consts::OS});
        let _ = std::fs::write(report, serde_json::to_vec_pretty(&payload).unwrap());
        app.exit(if passed { 0 } else { 1 });
    });
}
