#[cfg(target_os = "android")]
mod android_discovery;
#[cfg(desktop)]
mod docking;
mod host;
mod native_files;
#[cfg(all(desktop, debug_assertions))]
mod smoke;
mod window_commands;

use host::Host;
use pickdrop_core::Core;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use window_commands::NativeProtection;

#[tauri::command]
async fn core_call(
    host: tauri::State<'_, Host>,
    window: tauri::WebviewWindow,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or_else(|| json!({}));
    if method == "send_file" {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .ok_or("缺少文件路径")?;
        host.permitted(path)?;
    }
    #[cfg(desktop)]
    let _protection = if matches!(method.as_str(), "send_file" | "receive_file") {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Some(NativeProtection::new(
            docking::owner(&window)?,
            format!(
                "native-transfer:{}",
                SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ),
        ))
    } else {
        None
    };
    #[cfg(mobile)]
    let _ = window;
    host.core
        .dispatch(&method, params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_back_default(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(mobile)]
    return tauri::async_runtime::spawn_blocking(move || {
        app.state::<tauri_plugin_pickdrop_native::Native<tauri::Wry>>()
            .call("backDefault", json!({}))
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(json!({}))
    }
}

#[cfg(desktop)]
fn forward_anchor_drop(anchor: &tauri::WebviewWindow, paths: &[PathBuf]) -> Result<(), String> {
    let owner = docking::owner(anchor)?;
    let host = anchor.state::<Host>();
    let group_id = docking::drop_group(&owner);
    let approved: Vec<_> = paths
        .iter()
        .take(100)
        .filter(|p| p.is_file())
        .filter_map(|p| host.allow(p).ok())
        .collect();
    docking::file_hover(&owner, false); // Native finally: also covers unreadable and empty drops.
    static DROP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let drop_id = format!(
        "{}-{}-{}",
        owner.label(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        DROP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let payload = json!({"owner":owner.label(),"groupId":group_id,"dropId":drop_id,"paths":approved,"rejected":paths.len().saturating_sub(approved.len())});
    owner
        .emit_to(owner.label(), "pickdrop:anchor-drop", payload)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_pickdrop_native::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .invoke_handler(tauri::generate_handler![
            core_call,
            native_files::native_pick_files,
            native_files::native_paste_image,
            native_files::native_save_file,
            native_files::native_open_file,
            native_files::native_thumbnail,
            native_files::native_image_preview,
            native_files::native_share_file,
            native_files::native_save_gallery,
            native_files::native_consume_incoming,
            native_back_default,
            native_files::native_drag_file,
            window_commands::window_action,
            window_commands::window_animal,
            window_commands::window_resize,
            window_commands::window_context,
            window_commands::window_protection
        ])
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            #[cfg(all(desktop, debug_assertions))]
            let data = std::env::var_os("PICKDROP_NATIVE_SMOKE")
                .map(|p| PathBuf::from(p).with_extension("data"))
                .unwrap_or(data);
            std::fs::create_dir_all(&data)?;
            // Compare paths in the same namespace: Windows canonical paths use
            // the extended-length prefix, and mobile data dirs can be aliases.
            let data = data.canonicalize()?;
            let kind = if cfg!(mobile) { "mobile" } else { "desktop" };
            let core = tauri::async_runtime::block_on(Core::open(data.clone(), kind))?;
            let mut events = core.subscribe();
            app.manage(Host::new(core, data));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let _ = handle.emit("pickdrop:event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = handle.emit("pickdrop:event", json!({"type":"resync"}));
                        }
                        Err(_) => break,
                    }
                }
            });
            #[cfg(target_os = "android")]
            android_discovery::launch(app.handle().clone());
            #[cfg(desktop)]
            {
                app.manage(docking::Docking::new(
                    app.state::<Host>().data.join("windows.json"),
                ));
                setup_tray(app)?;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = docking::restore(&window);
                }
            }
            #[cfg(all(desktop, debug_assertions))]
            if let Some(report) = std::env::var_os("PICKDROP_NATIVE_SMOKE") {
                smoke::launch(app.handle().clone(), PathBuf::from(report));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                if docking::is_anchor(&w) {
                    if let Ok(owner) = docking::owner(&w) {
                        match event {
                            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                                paths,
                                ..
                            }) => {
                                let _ = forward_anchor_drop(&w, paths);
                            }
                            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter {
                                ..
                            }) => docking::file_hover(&owner, true),
                            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave) => {
                                docking::file_hover(&owner, false)
                            }
                            tauri::WindowEvent::Focused(false) => {
                                docking::file_hover(&owner, false);
                                docking::blurred(owner);
                            }
                            _ => {}
                        }
                    }
                    return;
                }
                match event {
                    tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { .. }) => {
                        docking::file_hover(&w, true)
                    }
                    tauri::WindowEvent::DragDrop(
                        tauri::DragDropEvent::Leave | tauri::DragDropEvent::Drop { .. },
                    ) => docking::file_hover(&w, false),
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = docking::hide(&w);
                    }
                    tauri::WindowEvent::Moved(_) => docking::moved(&w),
                    tauri::WindowEvent::Resized(_) => docking::resized(&w),
                    tauri::WindowEvent::Focused(false) => docking::blurred(w),

                    _ => {}
                }
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let host = window.state::<Host>();
                for path in paths {
                    let _ = host.allow(path);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动拾传");
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let show = MenuItem::with_id(app, "show", "打开拾传", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("拾传")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = docking::expand(&w);
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
