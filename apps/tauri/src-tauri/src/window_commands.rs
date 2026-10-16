//! Window command adapters and scoped protection during native operations.
#[cfg(desktop)]
use crate::docking;
use serde_json::Value;
#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
pub(crate) struct NativeProtection {
    window: tauri::WebviewWindow,
    reason: String,
}
#[cfg(desktop)]
impl NativeProtection {
    pub(crate) fn new(window: tauri::WebviewWindow, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        docking::protection(&window, &reason, true);
        Self { window, reason }
    }
}
#[cfg(desktop)]
impl Drop for NativeProtection {
    fn drop(&mut self) {
        docking::protection(&self.window, &self.reason, false);
    }
}

#[tauri::command]
pub(crate) async fn window_resize(
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if !width.is_finite() || !height.is_finite() {
            return Err("无效窗口尺寸".into());
        }
        docking::resize(&window, width, height)
    }
    #[cfg(mobile)]
    {
        let _ = (window, width, height);
        Err("手机端不支持窗口缩放".into())
    }
}

#[tauri::command]
pub(crate) async fn window_animal(
    window: tauri::WebviewWindow,
    animal_id: Option<String>,
) -> Result<String, String> {
    #[cfg(desktop)]
    {
        if let Some(animal) = animal_id {
            docking::animal(&docking::owner(&window)?, &animal)?;
        }
        docking::anchor_animal(&window)
    }
    #[cfg(mobile)]
    {
        let _ = (window, animal_id);
        Ok("cat".into())
    }
}

#[tauri::command]
pub(crate) async fn window_action(
    window: tauri::WebviewWindow,
    action: String,
    value: Option<bool>,
) -> Result<(), String> {
    #[cfg(desktop)]
    let window = docking::owner(&window)?;
    #[cfg(desktop)]
    match action.as_str() {
        "edge-docking" | "file-hover" | "sync" | "pointer-leave" | "anchor-drag-end"
        | "upload-busy" | "pin" | "dock-left" | "dock-right" | "dock-top" | "dock-bottom"
        | "undock" | "collapse" | "expand" | "busy" => docking::action(&window, &action, value),
        "drag" => {
            docking::begin_drag(&window);
            window.start_dragging().map_err(|e| e.to_string())
        }
        "hide" => docking::hide(&window),
        "show" => {
            docking::expand(&window)?;
            window.set_focus().map_err(|e| e.to_string())
        }
        "new" => {
            let label = format!(
                "group-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_millis()
            );
            let group = docking::context(&window, None)
                .get("groupId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let builder = tauri::WebviewWindowBuilder::new(
                window.app_handle(),
                label,
                tauri::WebviewUrl::App(format!("index.html?group={group}").into()),
            )
            .title("拾传")
            .inner_size(docking::PANEL_DEFAULT.0, docking::PANEL_DEFAULT.1)
            .min_inner_size(docking::PANEL_MIN.0, docking::PANEL_MIN.1)
            .max_inner_size(docking::PANEL_MAX.0, docking::PANEL_MAX.1)
            .maximizable(false);
            #[cfg(target_os = "macos")]
            let builder = builder.decorations(false).transparent(true);
            builder.build().map_err(|e| e.to_string())?;
            Ok(())
        }
        _ => Err("未知窗口操作".into()),
    }
    #[cfg(mobile)]
    {
        let _ = (window, action, value);
        Err("手机端不支持桌面窗口操作".into())
    }
}

#[tauri::command]
pub(crate) fn window_context(
    window: tauri::WebviewWindow,
    context: Option<Value>,
) -> Result<Value, String> {
    #[cfg(desktop)]
    {
        let main = docking::owner(&window)?;
        if docking::is_anchor(&window) {
            return Ok(docking::context(&main, None));
        }
        Ok(docking::context(&main, context))
    }
    #[cfg(mobile)]
    {
        let _ = (window, context);
        Ok(Value::Null)
    }
}
#[tauri::command]
pub(crate) fn window_protection(
    window: tauri::WebviewWindow,
    reason: String,
    value: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let owner = docking::owner(&window)?;
        if reason == "file-hover" {
            docking::file_hover(&owner, value);
        } else {
            docking::protection(&owner, &reason, value);
        }
    }
    #[cfg(mobile)]
    {
        let _ = (window, reason, value);
    }
    Ok(())
}
