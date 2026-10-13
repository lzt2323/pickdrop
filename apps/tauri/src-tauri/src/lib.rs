#[cfg(target_os = "android")]
mod android_discovery;
#[cfg(desktop)]
mod docking;
#[cfg(all(desktop, debug_assertions))]
mod smoke;
use base64::Engine;
use pickdrop_core::Core;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::Cursor,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

struct Host {
    core: Core,
    files: Mutex<HashSet<PathBuf>>,
    data: PathBuf,
}
impl Host {
    fn allow(&self, path: &Path) -> Result<PathBuf, String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let mut files = self.files.lock().map_err(|e| e.to_string())?;
        files.insert(path.clone());
        let data = serde_json::to_vec(&*files).map_err(|e| e.to_string())?;
        let temporary = self.data.join("approved-files.tmp");
        std::fs::write(&temporary, data).map_err(|e| e.to_string())?;
        std::fs::rename(temporary, self.data.join("approved-files.json"))
            .map_err(|e| e.to_string())?;
        Ok(path)
    }
    fn permitted(&self, path: &str) -> Result<PathBuf, String> {
        let files = self.files.lock().map_err(|e| e.to_string())?;
        permitted_path(&self.data, &files, path)
    }
}

fn permitted_path(data: &Path, approved: &HashSet<PathBuf>, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if approved.contains(&path) || path.starts_with(data) {
        Ok(path)
    } else {
        Err("请先通过文件选择器选择该文件".into())
    }
}

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

#[cfg(desktop)]
struct NativeProtection {
    window: tauri::WebviewWindow,
    reason: String,
}
#[cfg(desktop)]
impl NativeProtection {
    fn new(window: tauri::WebviewWindow, reason: impl Into<String>) -> Self {
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

// File dialogs are asynchronous; the actual stream copy runs off the UI thread.
#[tauri::command]
async fn native_pick_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    #[cfg(desktop)]
    let _protection = NativeProtection::new(docking::owner(&window)?, "native-file-picker");
    #[cfg(mobile)]
    let _ = window;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = tx.send(files);
    });
    let selected = rx.await.map_err(|e| e.to_string())?.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<Host>();
        let mut files = Vec::new();
        for file in selected {
            let display = file.to_string();
            let local_path = file.clone().into_path().ok();
            let name = local_path
                .as_deref()
                .and_then(Path::file_name)
                .and_then(|n| n.to_str())
                .unwrap_or("文件")
                .to_string();
            #[cfg(target_os = "android")]
            let name = if file.as_path().is_none() {
                app.state::<tauri_plugin_pickdrop_native::Native<tauri::Wry>>()
                    .call("metadata", json!({"path":display}))?
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("文件")
                    .to_string()
            } else {
                name
            };
            let path = if let Some(path) = file.as_path() {
                host.allow(path)?
            } else {
                // Android content:// and iOS security scoped URLs are read natively, never through JS.
                let dir = host.data.join("picked");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let unique = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos();
                let target = dir.join(unique.to_string());
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                let target = target.join(name.replace(['/', '\\'], "_"));
                let mut opts = tauri_plugin_fs::OpenOptions::new();
                opts.read(true);
                #[cfg(target_os = "ios")]
                let scoped = file.clone();
                let mut input = app.fs().open(file, opts).map_err(|e| e.to_string())?;
                let mut output = std::fs::File::create(&target).map_err(|e| e.to_string())?;
                let copied = std::io::copy(&mut input, &mut output);
                drop(input);
                #[cfg(target_os = "ios")]
                let _ = app.fs().stop_accessing_security_scoped_resource(scoped);
                if let Err(error) = copied {
                    let _ = std::fs::remove_file(&target);
                    return Err(error.to_string());
                }
                host.allow(&target)?
            };
            let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            files.push(json!({"path":path,"name":name,"size":size,"source":display}));
        }
        Ok(Value::Array(files))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_save_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    source_path: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    let _protection = NativeProtection::new(docking::owner(&window)?, "native-save-dialog");
    #[cfg(mobile)]
    let _ = window;
    let source = app.state::<Host>().permitted(&source_path)?;
    let name = Path::new(&suggested_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("文件")
        .to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(destination) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let display = destination.to_string();
        if destination
            .clone()
            .into_path()
            .ok()
            .and_then(|p| p.canonicalize().ok())
            .as_ref()
            == Some(&source)
        {
            return Ok(Some(display));
        }
        #[cfg(target_os = "ios")]
        let scoped = destination.clone();
        let mut opts = tauri_plugin_fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        let mut output = app
            .fs()
            .open(destination, opts)
            .map_err(|e| e.to_string())?;
        let mut input = std::fs::File::open(source).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut input, &mut output);
        drop(output);
        #[cfg(target_os = "ios")]
        let _ = app.fs().stop_accessing_security_scoped_resource(scoped);
        copied.map_err(|e| e.to_string())?;
        Ok(Some(display))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn safe_export_name(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or("文件");
    let mut clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(220)
        .collect();
    clean = clean.trim_end_matches(['.', ' ']).to_string();
    if clean.is_empty() {
        clean = "文件".into();
    }
    let stem = clean.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        clean.insert(0, '_');
    }
    clean
}

// Native exports preserve the original display name (cache objects are named by
// digest). Stream copy runs off the UI thread and keeps OS shares independent of
// cache eviction while another app is reading the file.
async fn prepare_export(
    app: &tauri::AppHandle,
    path: &str,
    suggested_name: Option<String>,
) -> Result<PathBuf, String> {
    let host = app.state::<Host>();
    let source = host.permitted(path)?;
    let data = host.data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut name = suggested_name
            .and_then(|n| {
                Path::new(&n)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(str::to_owned)
            })
            .filter(|n| !n.is_empty() && n != "." && n != "..")
            .unwrap_or_else(|| {
                source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        name = safe_export_name(&name);
        if Path::new(&name).extension().is_none() {
            use std::io::Read;
            let mut header = [0u8; 32];
            let count = std::fs::File::open(&source)
                .map_err(|e| e.to_string())?
                .read(&mut header)
                .map_err(|e| e.to_string())?;
            if let Ok(format) = image::guess_format(&header[..count]) {
                if let Some(extension) = format.extensions_str().first() {
                    name.push('.');
                    name.push_str(extension);
                }
            } else if header.starts_with(b"%PDF-") {
                name.push_str(".pdf");
            }
        }
        let directory = data.join("native-export");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        if let Ok(items) = std::fs::read_dir(&directory) {
            for item in items.flatten() {
                if item
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|d| d.as_secs() > 86400)
                {
                    let _ = std::fs::remove_dir_all(item.path());
                }
            }
        }
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let target = directory.join(unique.to_string());
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let target = target.join(name);
        std::fs::copy(source, &target).map_err(|e| e.to_string())?;
        Ok(target)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_open_file(
    app: tauri::AppHandle,
    path: String,
    suggested_name: Option<String>,
) -> Result<(), String> {
    let path = prepare_export(&app, &path, suggested_name).await?;
    #[cfg(mobile)]
    return tauri::async_runtime::spawn_blocking(move || {
        app.state::<tauri_plugin_pickdrop_native::Native<tauri::Wry>>()
            .call("open", json!({"path":path}))
            .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

// Both image surfaces share permission checks and decode limits. Limit concurrent
// decoders so opening several previews cannot multiply memory use without bound.
static IMAGE_DECODERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

fn image_data_url(path: &Path, max_edge: u32) -> Result<String, String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("图片过大，请打开原文件".into());
    }
    let mut reader = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| e.to_string())?;
    let preview = decoded.thumbnail(
        max_edge.min(decoded.width()),
        max_edge.min(decoded.height()),
    );
    let mut encoded = Cursor::new(Vec::new());
    preview
        .write_to(&mut encoded, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encoded.into_inner())
    ))
}

async fn permitted_image(
    app: tauri::AppHandle,
    path: String,
    max_edge: u32,
) -> Result<String, String> {
    let path = app.state::<Host>().permitted(&path)?;
    let permit = IMAGE_DECODERS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        image_data_url(&path, max_edge)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    permitted_image(app, path, 320).await
}

#[tauri::command]
async fn native_image_preview(app: tauri::AppHandle, path: String) -> Result<String, String> {
    permitted_image(app, path, 1600).await
}

#[tauri::command]
async fn native_share_file(
    app: tauri::AppHandle,
    path: String,
    suggested_name: Option<String>,
) -> Result<Value, String> {
    let path = prepare_export(&app, &path, suggested_name).await?;
    #[cfg(mobile)]
    return tauri::async_runtime::spawn_blocking(move || {
        app.state::<tauri_plugin_pickdrop_native::Native<tauri::Wry>>()
            .call("share", json!({"path":path}))
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    {
        let _ = path;
        Err("桌面端请使用保存或打开文件".into())
    }
}

#[tauri::command]
async fn native_save_gallery(
    app: tauri::AppHandle,
    path: String,
    suggested_name: Option<String>,
) -> Result<Value, String> {
    let path = prepare_export(&app, &path, suggested_name).await?;
    #[cfg(mobile)]
    return tauri::async_runtime::spawn_blocking(move || {
        app.state::<tauri_plugin_pickdrop_native::Native<tauri::Wry>>()
            .call("saveGallery", json!({"path":path}))
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    {
        let _ = path;
        Err("桌面端请使用保存文件".into())
    }
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

#[tauri::command]
async fn native_consume_incoming(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(mobile)]
    return tauri::async_runtime::spawn_blocking(move || {
        let result = app
            .state::<tauri_plugin_pickdrop_native::Native<tauri::Wry>>()
            .call("consumeIncoming", json!({}))?;
        if let Some(items) = result.get("items").and_then(Value::as_array) {
            for item in items {
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    app.state::<Host>().allow(Path::new(path))?;
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(json!({"items":[]}))
    }
}

#[tauri::command]
async fn native_drag_file(
    window: tauri::WebviewWindow,
    path: String,
    suggested_name: Option<String>,
) -> Result<(), String> {
    let path = prepare_export(window.app_handle(), &path, suggested_name).await?;
    #[cfg(desktop)]
    {
        docking::action(&window, "file-drag-busy", Some(true))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            let raw = window.gtk_window();
            #[cfg(not(target_os = "linux"))]
            let raw = Ok::<_, tauri::Error>(window.clone());
            let result = raw.map_err(|e| e.to_string()).and_then(|raw| {
                drag::start_drag(
                    &raw,
                    drag::DragItem::Files(vec![path]),
                    drag::Image::Raw(include_bytes!("../icons/drag-icon.png").to_vec()),
                    |_, _| {},
                    drag::Options::default(),
                )
                .map_err(|e| e.to_string())
            });
            let _ = docking::action(&window, "file-drag-busy", Some(false));
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    #[cfg(mobile)]
    {
        let _ = path;
        Err("手机端请使用分享按钮".into())
    }
}

#[tauri::command]
async fn window_resize(
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
async fn window_animal(
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
async fn window_action(
    window: tauri::WebviewWindow,
    action: String,
    value: Option<bool>,
) -> Result<(), String> {
    #[cfg(desktop)]
    let window = docking::owner(&window)?;
    #[cfg(desktop)]
    match action.as_str() {
        "file-hover" | "sync" | "pointer-leave"
        | "anchor-drag-end" | "upload-busy" | "pin" | "dock-left" | "dock-right" | "dock-top"
        | "dock-bottom" | "undock" | "collapse" | "expand" | "busy" => {
            docking::action(&window, &action, value)
        }
        "drag" => {docking::begin_drag(&window);window.start_dragging().map_err(|e|e.to_string())},
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
            .title("拾传 Preview")
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
fn window_context(window: tauri::WebviewWindow, context: Option<Value>) -> Result<Value, String> {
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
fn window_protection(
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
            native_pick_files,
            native_save_file,
            native_open_file,
            native_thumbnail,
            native_image_preview,
            native_share_file,
            native_save_gallery,
            native_consume_incoming,
            native_back_default,
            native_drag_file,
            window_action,
            window_animal,
            window_resize,
            window_context,
            window_protection
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
            app.manage(Host {
                core,
                files: Mutex::new(
                    std::fs::read(data.join("approved-files.json"))
                        .ok()
                        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                        .unwrap_or_default(),
                ),
                data,
            });
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
        .expect("无法启动拾传 Preview");
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
        .tooltip("拾传 Preview")
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

#[cfg(test)]
mod tests {
    use super::safe_export_name;
    #[test]
    fn preview_and_thumbnail_use_distinct_bounded_sizes() {
        use base64::Engine;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("landscape.png");
        image::RgbImage::from_pixel(2000, 1000, image::Rgb([20, 40, 60]))
            .save(&path)
            .unwrap();
        for (edge, expected) in [(320, (320, 160)), (1600, (1600, 800))] {
            let url = super::image_data_url(&path, edge).unwrap();
            let png = base64::engine::general_purpose::STANDARD
                .decode(url.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            let decoded = image::load_from_memory(&png).unwrap();
            assert_eq!((decoded.width(), decoded.height()), expected);
        }
    }

    #[test]
    fn small_images_are_not_upscaled() {
        use base64::Engine;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("small.png");
        image::RgbImage::new(32, 24).save(&path).unwrap();
        for edge in [320, 1600] {
            let url = super::image_data_url(&path, edge).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(url.split_once(',').unwrap().1)
                .unwrap();
            let image = image::load_from_memory(&bytes).unwrap();
            assert_eq!((image.width(), image.height()), (32, 24));
        }
    }

    #[test]
    fn image_preview_rejects_bad_and_oversized_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.png");
        std::fs::write(&path, b"not an image").unwrap();
        assert!(super::image_data_url(&path, 1600).is_err());
        std::fs::File::create(&path)
            .unwrap()
            .set_len(16 * 1024 * 1024 + 1)
            .unwrap();
        assert_eq!(
            super::image_data_url(&path, 1600).unwrap_err(),
            "图片过大，请打开原文件"
        );
        image::RgbImage::new(8193, 1).save(&path).unwrap();
        assert!(super::image_data_url(&path, 1600).is_err());
    }

    #[test]
    fn exports_cannot_escape_directory_or_create_reserved_windows_names() {
        assert_eq!(safe_export_name("../../private/照片.png"), "照片.png");
        assert_eq!(safe_export_name("C:\\private\\file.jpg"), "file.jpg");
        assert_eq!(safe_export_name("CON.jpg"), "_CON.jpg");
        assert_eq!(safe_export_name("a:b?.png"), "a_b_.png");
        assert_eq!(safe_export_name(".."), "文件");
    }
    #[test]
    fn downloaded_cache_is_approved_without_picker_and_outside_is_denied() {
        let temporary = tempfile::tempdir().unwrap();
        let app_data = temporary.path().join("preview-data");
        let cache = app_data.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let downloaded = cache.join("sha256-object");
        std::fs::write(&downloaded, b"received bytes").unwrap();
        let outside = temporary.path().join("private.txt");
        std::fs::write(&outside, b"outside bytes").unwrap();
        let data = app_data.canonicalize().unwrap();
        let approved = std::collections::HashSet::new();
        assert_eq!(
            super::permitted_path(&data, &approved, &downloaded.to_string_lossy()).unwrap(),
            downloaded.canonicalize().unwrap()
        );
        assert!(super::permitted_path(&data, &approved, &outside.to_string_lossy()).is_err());
        #[cfg(unix)]
        {
            let alias = cache.join("outside-alias");
            std::os::unix::fs::symlink(&outside, &alias).unwrap();
            assert!(super::permitted_path(&data, &approved, &alias.to_string_lossy()).is_err());
            let app_alias = temporary.path().join("android-data-alias");
            std::os::unix::fs::symlink(&app_data, &app_alias).unwrap();
            assert!(super::permitted_path(
                &app_alias.canonicalize().unwrap(),
                &approved,
                &downloaded.to_string_lossy()
            )
            .is_ok());
        }
    }
}
