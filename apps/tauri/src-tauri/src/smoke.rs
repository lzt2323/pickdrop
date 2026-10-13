//! Opt-in debug smoke exercises actual native window APIs in the desktop session.
//! Uses an isolated data directory and exits; never compiled into release builds.
use serde_json::json;
use tauri::{Emitter, Listener, Manager};
pub fn launch(app: tauri::AppHandle, report: std::path::PathBuf) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        let geometry = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
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
            super::window_resize(window.clone(), 1400., 1000.).await?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let compact = window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
            if (compact.width - 380.).abs() > 0.5 || (compact.height - 520.).abs() > 0.5 {
                return Err("desktop resize exceeded compact limits".into());
            }
            if window.is_maximizable().map_err(|e| e.to_string())? {
                return Err("compact desktop still allows maximize".into());
            }
            super::window_resize(window.clone(), 350., 470.).await?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let resized = window.inner_size().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            if window.inner_size().map_err(|e| e.to_string())? != resized {
                return Err("focus reset resized window".into());
            }
            super::docking::resized(&window);
            super::docking::action(&window, "busy", Some(true))?;
            // A transient startup size is an OS layout, not a user resize.
            window
                .set_size(tauri::LogicalSize::new(320., 420.))
                .map_err(|e| e.to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            super::docking::restore(&window)?;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            if window.inner_size().map_err(|e| e.to_string())? != resized {
                return Err("restore discarded saved bounds for startup defaults".into());
            }
            verify_auto_edge(&window, None).await?;
            verify_drag_busy_isolation(&window).await?;
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
            if anchor.is_visible().map_err(|e| e.to_string())? {
                return Err("expanded panel still shows overlapping animal".into());
            }
            let monitor = window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .ok_or("monitor absent")?;
            let area = monitor.work_area();
            let position = window.outer_position().map_err(|e| e.to_string())?;
            let outer = window.outer_size().map_err(|e| e.to_string())?;
            if position.x + outer.width as i32 != area.position.x + area.size.width as i32 {
                return Err("expanded panel has animal-sized edge offset".into());
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
            verify_auto_edge(&window, Some(&other)).await?;
            verify_exit_timers(&window, &other).await?;
            verify_frame_fit(&window, &geometry).await?;
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
        let payload = json!({"passed":passed,"error":result.err(),"checks":["native file drag does not clear modal busy", "core bootstrap","compact size cap and no maximize","pin/unpin","transparent animal anchor", "frameless Mac panel", "expanded panel hides animal and has no edge offset", "anchor file drop approval and forwarding", "drag to each edge then inactivity auto collapses while pinned", "resize/focus preserves dimensions", "restore uses saved bounds", "edge collapse/expand preserves dimensions", "dragging away disables automatic collapse", "animal restore preserves panel edge and dimensions", "all edge and free resizes preserve frame center anchors", "overshoot and corner restore fit actual OS outer frame", "repeated center resizing is stable", "hide/show","multiwindow","rapid exit retrigger preserves full grace","exit timers are independent across windows","expand and hide invalidate old exit timers","native event emission"],"geometry": *geometry.lock().unwrap(), "platform":std::env::consts::OS});
        let _ = std::fs::write(report, serde_json::to_vec_pretty(&payload).unwrap());
        app.exit(if passed { 0 } else { 1 });
    });
}

async fn verify_drag_busy_isolation(window: &tauri::WebviewWindow) -> Result<(), String> {
    super::docking::action(window, "dock-right", None)?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?.ok_or("monitor absent")?;
    let area = monitor.work_area();
    let position = window.outer_position().map_err(|e| e.to_string())?;
    window.set_cursor_position(tauri::PhysicalPosition::new(area.position.x + area.size.width as i32 / 2 - position.x, area.position.y + area.size.height as i32 - 4 - position.y)).map_err(|e| e.to_string())?;
    super::docking::action(window, "busy", Some(true))?;
    super::docking::action(window, "file-drag-busy", Some(true))?;
    super::docking::action(window, "file-drag-busy", Some(false))?;
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    if !window.is_visible().map_err(|e| e.to_string())? { return Err("file drag completion cleared modal protection".into()); }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    window.set_cursor_position(tauri::PhysicalPosition::new(cursor.x - position.x as f64, cursor.y - position.y as f64)).map_err(|e| e.to_string())?;
    super::docking::action(window, "busy", Some(false))?;
    super::docking::expand(window)
}

async fn verify_auto_edge(
    window: &tauri::WebviewWindow,
    other: Option<&tauri::WebviewWindow>,
) -> Result<(), String> {
    use std::time::Duration;
    super::docking::action(window, "undock", None)?;
    super::docking::action(window, "busy", Some(false))?;
    // Pin is only z-order; a saved true value must not disable edge hiding.
    super::docking::action(window, "pin", Some(true))?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let original_cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("monitor absent")?;
    let area = monitor.work_area();
    let original_size = window.outer_size().map_err(|e| e.to_string())?;
    let other_visible = other.map(|other| other.is_visible().unwrap_or(false));
    let result = async {
        for edge in ["left", "right", "top", "bottom"] {
            let x = if edge == "right" {
                area.position.x + area.size.width as i32 - original_size.width as i32
            } else if edge == "left" {
                area.position.x
            } else {
                area.position.x + (area.size.width as i32 - original_size.width as i32) / 2
            };
            let y = if edge == "top" {
                area.position.y
            } else if edge == "bottom" {
                area.position.y + area.size.height as i32 - original_size.height as i32
            } else {
                area.position.y + 100
            };
            window
                .set_position(tauri::PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            super::docking::moved(window);
            // No UI collapse command: move outside and let edge inactivity work.
            let position = window.outer_position().map_err(|e| e.to_string())?;
            window
                .set_cursor_position(tauri::PhysicalPosition::new(
                    area.position.x + area.size.width as i32 / 2 - position.x,
                    (if edge == "bottom" {
                        area.position.y + 4
                    } else {
                        area.position.y + area.size.height as i32 - 4
                    }) - position.y,
                ))
                .map_err(|e| e.to_string())?;
            // This case models an idle panel. A focused keyboard control now
            // deliberately protects active operations from pointer-only hiding.
            window.eval("document.activeElement?.blur()").map_err(|e|e.to_string())?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            super::docking::blurred(window.clone());
            tokio::time::sleep(Duration::from_millis(900)).await;
            let anchor = window
                .app_handle()
                .get_webview_window(&format!("anchor-{}", window.label()))
                .ok_or("auto collapse animal absent")?;
            if window.is_visible().map_err(|e| e.to_string())?
                || !anchor.is_visible().map_err(|e| e.to_string())?
            {
                return Err(format!("{edge} edge did not auto collapse while pinned"));
            }
            if other.map(|other| other.is_visible().unwrap_or(false)) != other_visible {
                return Err("auto collapse changed other group visibility".into());
            }
            super::window_action(anchor.clone(), "expand".into(), None).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            if !window.is_visible().map_err(|e| e.to_string())?
                || anchor.is_visible().map_err(|e| e.to_string())?
                || window.outer_position().map_err(|e| e.to_string())?
                    != tauri::PhysicalPosition::new(x, y)
            {
                return Err(format!(
                    "{edge} animal restore shifted panel or left animal visible"
                ));
            }
            let center = (
                x * 2 + original_size.width as i32,
                y * 2 + original_size.height as i32,
            );
            for (width, height) in [(320., 420.), (350., 470.)] {
                super::window_resize(window.clone(), width, height).await?;
                tokio::time::sleep(Duration::from_millis(300)).await;
                let p = window.outer_position().map_err(|e| e.to_string())?;
                let size = window.outer_size().map_err(|e| e.to_string())?;
                if (edge == "left"
                    && (p.x != area.position.x
                        || (p.y * 2 + size.height as i32 - center.1).abs() > 1))
                    || (edge == "right"
                        && (p.x + size.width as i32 != area.position.x + area.size.width as i32
                            || (p.y * 2 + size.height as i32 - center.1).abs() > 1))
                    || (edge == "top"
                        && (p.y != area.position.y
                            || (p.x * 2 + size.width as i32 - center.0).abs() > 1))
                    || (edge == "bottom"
                        && (p.y + size.height as i32 != area.position.y + area.size.height as i32
                            || (p.x * 2 + size.width as i32 - center.0).abs() > 1))
                {
                    return Err(format!("{edge} resize moved panel off its geometry anchor"));
                }
            }
            // Put size back before checking the next edge.
            window.set_size(original_size).map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let x = area.position.x + (area.size.width as i32 - original_size.width as i32) / 2;
        let y = area.position.y + 140;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        super::docking::moved(window);
        super::docking::blurred(window.clone());
        tokio::time::sleep(Duration::from_millis(900)).await;
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("free window auto collapsed after dragging away".into());
        }
        super::window_resize(window.clone(), 320., 420.).await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let p = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        if (p.x * 2 + size.width as i32 - x * 2 - original_size.width as i32).abs() > 1
            || (p.y * 2 + size.height as i32 - y * 2 - original_size.height as i32).abs() > 1
        {
            return Err("free resize moved center".into());
        }
        window.set_size(original_size).map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    if let Ok(p) = window.outer_position() {
        let _ = window.set_cursor_position(tauri::PhysicalPosition::new(
            original_cursor.x - p.x as f64,
            original_cursor.y - p.y as f64,
        ));
    }
    super::docking::action(window, "pin", Some(false))?;
    result
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
        for window in [main,other] {window.eval("document.activeElement?.blur()").map_err(|e|e.to_string())?;}
        tokio::time::sleep(Duration::from_millis(100)).await;
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

async fn verify_frame_fit(
    window: &tauri::WebviewWindow,
    geometry: &std::sync::Mutex<Vec<serde_json::Value>>,
) -> Result<(), String> {
    use std::time::Duration;
    use tauri::PhysicalPosition;
    super::docking::action(window, "busy", Some(false))?;
    super::docking::action(window, "undock", None)?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("monitor absent")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let before = window.outer_size().map_err(|e| e.to_string())?;
    let overshoot = (120. * scale) as i32;
    for (edge, x, y) in [
        ("left", area.position.x - overshoot, area.position.y + 120),
        (
            "right",
            area.position.x + area.size.width as i32 - before.width as i32 + overshoot,
            area.position.y + 120,
        ),
        ("top", area.position.x + 120, area.position.y - overshoot),
        (
            "bottom",
            area.position.x + 120,
            area.position.y + area.size.height as i32 - before.height as i32 + overshoot,
        ),
        (
            "left",
            area.position.x - overshoot,
            area.position.y + area.size.height as i32 - before.height as i32 + overshoot,
        ),
        (
            "right",
            area.position.x + area.size.width as i32 - before.width as i32 + overshoot,
            area.position.y + area.size.height as i32 - before.height as i32 + overshoot,
        ),
    ] {
        super::docking::action(window, "undock", None)?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        super::docking::moved(window);
        // Exercise automatic collapse policy even after a large overshoot.
        // Move the pointer to screen center, away from this edge/frame.
        let p = window.outer_position().map_err(|e| e.to_string())?;
        window
            .set_cursor_position(PhysicalPosition::new(
                area.position.x + area.size.width as i32 / 2 - p.x,
                area.position.y + 4 - p.y,
            ))
            .map_err(|e| e.to_string())?;
        super::docking::blurred(window.clone());
        tokio::time::sleep(Duration::from_millis(950)).await;
        if window.is_visible().map_err(|e| e.to_string())? {
            return Err(format!("{edge} overshoot did not collapse: {x},{y}"));
        }
        super::docking::expand(window)?;
        tokio::time::sleep(Duration::from_millis(350)).await;
        geometry
            .lock()
            .unwrap()
            .push(assert_frame_fits(window, &area)?);
        for (width, height) in [(380., 520.), (300., 360.), (320., 420.)] {
            super::window_resize(window.clone(), width, height).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            geometry
                .lock()
                .unwrap()
                .push(assert_frame_fits(window, &area)?);
        }
    }
    super::docking::action(window, "undock", None)?;
    super::window_resize(window.clone(), 320., 420.).await?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            area.position.x + (area.size.width as i32 - size.width as i32) / 2,
            area.position.y + (area.size.height as i32 - size.height as i32) / 2,
        ))
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let p = window.outer_position().map_err(|e| e.to_string())?;
    let center = (p.x * 2 + size.width as i32, p.y * 2 + size.height as i32);
    for _ in 0..3 {
        for (width, height) in [(380., 520.), (300., 360.), (350., 470.), (320., 420.)] {
            super::window_resize(window.clone(), width, height).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let p = window.outer_position().map_err(|e| e.to_string())?;
            let s = window.outer_size().map_err(|e| e.to_string())?;
            if (p.x * 2 + s.width as i32 - center.0).abs() > 1
                || (p.y * 2 + s.height as i32 - center.1).abs() > 1
            {
                return Err(format!(
                    "repeated resize shifted center: {center:?} => {p:?} {s:?}"
                ));
            }
            geometry
                .lock()
                .unwrap()
                .push(assert_frame_fits(window, &area)?);
        }
    }
    Ok(())
}
fn assert_frame_fits(
    window: &tauri::WebviewWindow,
    area: &tauri::PhysicalRect<i32, u32>,
) -> Result<serde_json::Value, String> {
    let p = window.outer_position().map_err(|e| e.to_string())?;
    let s = window.outer_size().map_err(|e| e.to_string())?;
    if p.x < area.position.x
        || p.y < area.position.y
        || p.x + s.width as i32 > area.position.x + area.size.width as i32
        || p.y + s.height as i32 > area.position.y + area.size.height as i32
    {
        return Err(format!(
            "OS frame outside work area: {p:?} {s:?} area={area:?}"
        ));
    }
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    Ok(
        json!({"outer_position":p,"outer_size":s,"inner_size":inner,"work_area":area,"scale":window.scale_factor().map_err(|e| e.to_string())?}),
    )
}
