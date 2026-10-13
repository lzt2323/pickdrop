//! Opt-in debug smoke exercises actual native window APIs in the desktop session.
//! Uses an isolated data directory and exits; never compiled into release builds.
use serde_json::json;
use tauri::{Emitter, Listener, Manager};
pub fn launch(app: tauri::AppHandle, report: std::path::PathBuf) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        let result: Result<(), String> = async {
            let window = app.get_webview_window("main").ok_or("main window absent")?;
            #[cfg(target_os = "macos")]
            if window.is_decorated().map_err(|e| e.to_string())? {
                return Err("Mac panel still has native titlebar".into());
            }
            super::docking::action(&window, "pin", Some(true))?;
            if !window.is_always_on_top().map_err(|e| e.to_string())? {
                return Err("pin failed".into());
            }
            super::docking::action(&window, "pin", Some(false))?;
            super::window_resize(window.clone(), 510., 690.).await?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let resized = window.inner_size().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            if window.inner_size().map_err(|e| e.to_string())? != resized {
                return Err("focus reset resized window".into());
            }
            super::docking::resized(&window);
            super::docking::action(&window, "busy", Some(true))?;
            super::window_resize(window.clone(), 440., 720.).await?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            super::docking::restore(&window)?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            if window.inner_size().map_err(|e| e.to_string())? != resized {
                return Err("restore discarded saved bounds for startup defaults".into());
            }
            super::docking::action(&window, "dock-right", None)?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            super::docking::action(&window, "collapse", None)?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let anchor = app
                .get_webview_window("anchor-main")
                .ok_or("animal anchor absent")?;
            let size = anchor.inner_size().map_err(|e| e.to_string())?;
            if !anchor.is_visible().map_err(|e| e.to_string())?
                || window.is_visible().map_err(|e| e.to_string())?
            {
                return Err("collapse visibility failed".into());
            }
            let scale = anchor.scale_factor().map_err(|e| e.to_string())?;
            if (size.width as f64 / scale - 56.).abs() > 1.
                || (size.height as f64 / scale - 56.).abs() > 1.
            {
                return Err(format!("animal size failed: {size:?}"));
            }
            if let Ok(delay) = std::env::var("PICKDROP_NATIVE_SMOKE_ANCHOR_PAUSE_MS") {
                tokio::time::sleep(std::time::Duration::from_millis(
                    delay.parse::<u64>().unwrap_or(0).min(10000),
                ))
                .await;
            }
            super::docking::action(&window, "expand", None)?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let size = window.inner_size().map_err(|e| e.to_string())?;
            if size != resized {
                return Err(format!("expand failed: {size:?}"));
            }
            if !anchor.is_visible().map_err(|e| e.to_string())? {
                return Err("expanded panel lost its animal".into());
            }
            let panel_position = window.outer_position().map_err(|e| e.to_string())?;
            let panel_size = window.outer_size().map_err(|e| e.to_string())?;
            let animal_position = anchor.outer_position().map_err(|e| e.to_string())?;
            let gap =
                (animal_position.x - panel_position.x - panel_size.width as i32) as f64 / scale;
            if (gap - 8.).abs() > 1. {
                return Err(format!("animal-panel gap is {gap}, expected 8"));
            }
            let original_cursor = window.cursor_position().map_err(|e| e.to_string())?;
            anchor
                .set_cursor_position(tauri::LogicalPosition::new(28., 28.))
                .map_err(|e| e.to_string())?;
            super::docking::blurred(window.clone());
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;
            let stayed_open = window.is_visible().map_err(|e| e.to_string())?;
            let current_position = window.outer_position().map_err(|e| e.to_string())?;
            window
                .set_cursor_position(tauri::PhysicalPosition::new(
                    original_cursor.x - current_position.x as f64,
                    original_cursor.y - current_position.y as f64,
                ))
                .map_err(|e| e.to_string())?;
            if !stayed_open {
                return Err("moving pointer onto animal collapsed the panel".into());
            }
            if let Ok(delay) = std::env::var("PICKDROP_NATIVE_SMOKE_PANEL_PAUSE_MS") {
                super::docking::action(&window, "pin", Some(true))?;
                tokio::time::sleep(std::time::Duration::from_millis(
                    delay.parse::<u64>().unwrap_or(0).min(10000),
                ))
                .await;
            }
            super::docking::action(&window, "pin", Some(false))?;
            let received = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let observed = received.clone();
            let listener = window.listen("pickdrop:anchor-drop", move |_| {
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            let dropped = std::env::temp_dir()
                .join(format!("pickdrop-anchor-drop-{}.txt", std::process::id()));
            std::fs::write(&dropped, b"native anchor drag and drop").map_err(|e| e.to_string())?;
            super::forward_anchor_drop(&anchor, std::slice::from_ref(&dropped))?;
            if !received.load(std::sync::atomic::Ordering::SeqCst)
                || app
                    .state::<super::Host>()
                    .permitted(&dropped.to_string_lossy())
                    .is_err()
            {
                return Err("animal file drop did not approve and forward path".into());
            }
            window.unlisten(listener);
            let _ = std::fs::remove_file(dropped);
            super::docking::action(&window, "upload-busy", Some(false))?;
            super::docking::hide(&window)?;
            if window.is_visible().map_err(|e| e.to_string())? {
                return Err("hide failed".into());
            }
            window.show().map_err(|e| e.to_string())?;
            if !window.is_visible().map_err(|e| e.to_string())? {
                return Err("show failed".into());
            }
            super::window_action(window.clone(), "new".into(), None).await?;
            if app
                .webview_windows()
                .keys()
                .filter(|label| !label.starts_with("anchor-"))
                .count()
                != 2
            {
                return Err("new window failed".into());
            }
            let other = app
                .webview_windows()
                .into_iter()
                .find(|(label, _)| label.starts_with("group-"))
                .map(|(_, window)| window)
                .ok_or("second group window absent")?;
            verify_exit_timers(&window, &other).await?;
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
        let payload = json!({"passed":passed,"error":result.err(),"checks":["core bootstrap","pin/unpin","transparent animal anchor", "frameless Mac panel", "expanded animal and panel with 8px gap", "anchor file drop approval and forwarding", "pointer over animal keeps panel expanded", "resize/focus preserves dimensions", "restore uses saved bounds", "edge collapse/expand preserves dimensions","hide/show","multiwindow","rapid exit retrigger preserves full grace","exit timers are independent across windows","expand and hide invalidate old exit timers","native event emission"],"platform":std::env::consts::OS});
        let _ = std::fs::write(report, serde_json::to_vec_pretty(&payload).unwrap());
        app.exit(if passed { 0 } else { 1 });
    });
}

async fn verify_exit_timers(
    main: &tauri::WebviewWindow,
    other: &tauri::WebviewWindow,
) -> Result<(), String> {
    use std::time::Duration;
    let original = main.cursor_position().map_err(|e| e.to_string())?;
    let result = async {
        for window in [main, other] {
            super::docking::action(window, "pin", Some(false))?;
            super::docking::action(window, "busy", Some(false))?;
        }
        super::docking::action(main, "dock-right", None)?;
        super::docking::action(other, "dock-left", None)?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let monitor = main
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("monitor absent")?;
        let area = monitor.work_area();
        let position = main.outer_position().map_err(|e| e.to_string())?;
        main.set_cursor_position(tauri::PhysicalPosition::new(
            area.position.x + area.size.width as i32 / 2 - position.x,
            area.position.y + area.size.height as i32 - 4 - position.y,
        ))
        .map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        if super::docking::pointer_inside(main) || super::docking::pointer_inside(other) {
            return Err("timer smoke requires cursor outside both window pairs".into());
        }
        super::docking::expand(main)?;
        super::docking::expand(other)?;
        super::docking::blurred(main.clone());
        super::docking::blurred(other.clone());
        tokio::time::sleep(Duration::from_millis(500)).await;
        super::docking::blurred(main.clone());
        tokio::time::sleep(Duration::from_millis(400)).await;
        if !main.is_visible().map_err(|e| e.to_string())? {
            return Err("old exit timer shortened latest main-window grace".into());
        }
        if other.is_visible().map_err(|e| e.to_string())? {
            return Err("main-window timer reset also reset independent group window".into());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        if main.is_visible().map_err(|e| e.to_string())? {
            return Err("latest main exit timer did not collapse after full grace".into());
        }
        super::docking::expand(main)?;
        super::docking::blurred(main.clone());
        tokio::time::sleep(Duration::from_millis(400)).await;
        super::docking::expand(main)?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !main.is_visible().map_err(|e| e.to_string())? {
            return Err("expand did not invalidate pending exit timer".into());
        }
        super::docking::blurred(main.clone());
        tokio::time::sleep(Duration::from_millis(400)).await;
        super::docking::hide(main)?;
        main.show().map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !main.is_visible().map_err(|e| e.to_string())? {
            return Err("hide did not invalidate pending exit timer".into());
        }
        Ok(())
    }
    .await;
    if let Ok(position) = main.outer_position() {
        let _ = main.set_cursor_position(tauri::PhysicalPosition::new(
            original.x - position.x as f64,
            original.y - position.y as f64,
        ));
    }
    result
}
