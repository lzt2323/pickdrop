//! File selection, safe export copies, and bounded image previews.
use crate::host::Host;
#[cfg(desktop)]
use crate::{docking, window_commands::NativeProtection};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub(crate) async fn native_paste_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<Value>, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let reason = format!("clipboard-{}", pickdrop_core::protocol::random(12));
        let _protection = NativeProtection::new(docking::owner(&window)?, &reason);
        tauri::async_runtime::spawn_blocking(move || {
            let image = match app.clipboard().read_image() {
                Ok(image) => image,
                // The plugin converts arboard's typed ContentNotAvailable error
                // into this string. An ordinary text paste is not an image error.
                Err(tauri_plugin_clipboard_manager::Error::Clipboard(message))
                    if message == "The clipboard contents were not available in the requested format or the clipboard is empty." => return Ok(None),
                Err(error) => return Err(format!("无法读取剪贴板图片：{error}")),
            };
            let host = app.state::<Host>();
            stage_clipboard_image(&host.data, image.width(), image.height(), image.rgba()).map(Some)
        }).await.map_err(|error| error.to_string())?
    }
    #[cfg(mobile)]
    {
        let _ = (app, window);
        Err("手机端请通过文件选择或系统分享添加图片".into())
    }
}

#[cfg(desktop)]
fn stage_clipboard_image(
    data: &Path,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<Value, String> {
    use image::ImageEncoder;
    let expected = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4));
    if width == 0
        || height == 0
        || expected.is_none_or(|bytes| bytes > 64 * 1024 * 1024 || bytes != rgba.len() as u64)
    {
        return Err("剪贴板图片尺寸无效或超过 64 MiB 像素上限".into());
    }
    let directory = data.join("clipboard");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let name = format!("clipboard-{}.png", pickdrop_core::protocol::random(12));
    let path = directory.join(&name);
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    if let Err(error) = image::codecs::png::PngEncoder::new(file).write_image(
        rgba,
        width,
        height,
        image::ExtendedColorType::Rgba8,
    ) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("无法保存剪贴板图片：{error}"));
    }
    let size = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    Ok(json!({"path":path,"name":name,"size":size,"mimeType":"image/png"}))
}

// File dialogs are asynchronous; the actual stream copy runs off the UI thread.
#[tauri::command]
pub(crate) async fn native_pick_files(
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
pub(crate) async fn native_save_file(
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
pub(crate) async fn native_open_file(
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
pub(crate) async fn native_thumbnail(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    permitted_image(app, path, 320).await
}

#[tauri::command]
pub(crate) async fn native_image_preview(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    permitted_image(app, path, 1600).await
}

#[tauri::command]
pub(crate) async fn native_share_file(
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
pub(crate) async fn native_save_gallery(
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
pub(crate) async fn native_consume_incoming(app: tauri::AppHandle) -> Result<Value, String> {
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
pub(crate) async fn native_drag_file(
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

#[cfg(test)]
mod tests {
    use super::safe_export_name;
    #[cfg(desktop)]
    #[test]
    fn clipboard_image_staging_preserves_pixels_and_uses_unique_app_owned_files() {
        let directory = tempfile::tempdir().unwrap();
        let pixels = [255, 0, 0, 255, 0, 255, 0, 128];
        let first = super::stage_clipboard_image(directory.path(), 2, 1, &pixels).unwrap();
        let second = super::stage_clipboard_image(directory.path(), 2, 1, &pixels).unwrap();
        assert_ne!(first["path"], second["path"]);
        let path = std::path::Path::new(first["path"].as_str().unwrap());
        assert!(path.starts_with(directory.path().join("clipboard")));
        assert_eq!(image::open(path).unwrap().to_rgba8().as_raw(), &pixels);
        assert_eq!(
            first["size"].as_u64().unwrap(),
            std::fs::metadata(path).unwrap().len()
        );
        assert_eq!(first["mimeType"], "image/png");
    }
    #[cfg(desktop)]
    #[test]
    fn invalid_clipboard_dimensions_and_pixel_counts_do_not_create_files() {
        let directory = tempfile::tempdir().unwrap();
        for (width, height, pixels) in [
            (0, 1, vec![]),
            (2, 1, vec![0; 4]),
            (4097, 4096, vec![]),
            (u32::MAX, u32::MAX, vec![]),
        ] {
            assert!(
                super::stage_clipboard_image(directory.path(), width, height, &pixels).is_err()
            );
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
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
}
