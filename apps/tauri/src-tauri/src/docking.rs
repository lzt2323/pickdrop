//! Native edge docking. Window coordinates are physical pixels; monitor DPI is
//! applied only to the visible tab and snap threshold.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Record {
    edge: Option<String>,
    expanded: Option<Bounds>,
    collapsed: bool,
    pinned: bool,
    #[serde(default = "default_animal")]
    animal: String,
    #[serde(skip)]
    busy: bool,
    #[serde(skip)]
    upload_busy: bool,
    #[serde(skip)]
    file_hover: bool,
    #[serde(skip)]
    layout_until: Option<std::time::Instant>,
}
fn default_animal() -> String {
    "cat".into()
}

pub struct Docking {
    records: Mutex<HashMap<String, Record>>,
    path: PathBuf,
    writer: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
}
impl Docking {
    pub fn new(path: PathBuf) -> Self {
        let records = std::fs::read(&path)
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_default();
        Self {
            records: Mutex::new(records),
            path,
            writer: Arc::new(Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
    fn get(&self, w: &WebviewWindow) -> Record {
        self.records
            .lock()
            .unwrap()
            .get(w.label())
            .cloned()
            .unwrap_or_default()
    }
    fn put(&self, w: &WebviewWindow, r: Record) {
        self.records.lock().unwrap().insert(w.label().into(), r);
    }
    fn save(&self) {
        if let Ok(data) = serde_json::to_vec(&*self.records.lock().unwrap()) {
            let path = self.path.clone();
            let writer = self.writer.clone();
            let generation = self.generation.clone();
            let current = generation.fetch_add(1, Ordering::SeqCst) + 1;
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = writer.lock().unwrap();
                if generation.load(Ordering::SeqCst) != current {
                    return;
                }
                let temporary = path.with_extension("tmp");
                if std::fs::write(&temporary, data).is_ok() {
                    let _ = std::fs::rename(temporary, path);
                }
            });
        }
    }
}
fn bounds(w: &WebviewWindow) -> Result<Bounds, String> {
    let p = w.outer_position().map_err(|e| e.to_string())?;
    let s = w.inner_size().map_err(|e| e.to_string())?;
    Ok(Bounds {
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
    })
}
fn emit(w: &WebviewWindow, r: &Record) {
    let state = serde_json::json!({"edge":r.edge,"collapsed":r.collapsed,"pinned":r.pinned});
    let _ = w.emit("pickdrop:window", &state);
    if let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) {
        let _ = anchor.emit("pickdrop:window", &state);
    }
}
fn apply(w: &WebviewWindow, b: Bounds) -> Result<(), String> {
    w.set_position(PhysicalPosition::new(b.x, b.y))
        .map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new(b.width, b.height))
        .map_err(|e| e.to_string())
}
pub fn is_anchor(w: &WebviewWindow) -> bool {
    w.label().starts_with("anchor-")
}
fn anchor_label(w: &WebviewWindow) -> String {
    format!("anchor-{}", w.label())
}
pub fn owner(w: &WebviewWindow) -> Result<WebviewWindow, String> {
    if let Some(label) = w.label().strip_prefix("anchor-") {
        w.app_handle()
            .get_webview_window(label)
            .ok_or("群窗口已关闭".into())
    } else {
        Ok(w.clone())
    }
}
pub fn animal(w: &WebviewWindow, animal: &str) -> Result<(), String> {
    let allowed = [
        "cat", "sheep", "monkey", "dog", "chick", "lizard", "alpaca", "rabbit", "otter", "capybara",
    ];
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    r.animal = if allowed.contains(&animal) {
        animal.into()
    } else {
        default_animal()
    };
    manager.put(w, r.clone());
    if let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) {
        let _ = anchor.emit("pickdrop:animal", &r.animal);
    }
    manager.save();
    Ok(())
}
pub fn anchor_animal(w: &WebviewWindow) -> Result<String, String> {
    let main = owner(w)?;
    let value = main.state::<Docking>().get(&main).animal;
    Ok(if value.is_empty() {
        default_animal()
    } else {
        value
    })
}
pub fn hide(w: &WebviewWindow) -> Result<(), String> {
    if let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) {
        anchor.hide().map_err(|e| e.to_string())?;
    }
    w.hide().map_err(|e| e.to_string())
}
fn show_anchor(w: &WebviewWindow, b: Bounds) -> Result<(), String> {
    let label = anchor_label(w);
    let anchor = if let Some(anchor) = w.app_handle().get_webview_window(&label) {
        anchor
    } else {
        tauri::WebviewWindowBuilder::new(
            w.app_handle(),
            label,
            tauri::WebviewUrl::App("anchor.html".into()),
        )
        .title("拾传 · 动物锚点")
        .inner_size(56., 56.)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?
    };
    apply(&anchor, b)?;
    anchor.show().map_err(|e| e.to_string())
}
pub fn restore(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    // Native geometry setters can enqueue events. Keep saved bounds authoritative
    // until the first layout is applied instead of re-reading the startup size.
    r.collapsed = r.expanded.is_some();
    r.busy = false;
    r.layout_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(250));
    manager.put(w, r);
    #[cfg(target_os = "macos")]
    w.set_decorations(false).map_err(|e| e.to_string())?;
    expand(w)
}
pub fn action(w: &WebviewWindow, action: &str, value: Option<bool>) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    match action {
        "sync" => {
            emit(w, &r);
            Ok(())
        }
        "pin" => {
            r.pinned = value.unwrap_or(true);
            manager.put(w, r.clone());
            w.set_always_on_top(r.pinned).map_err(|e| e.to_string())?;
            if r.pinned {
                expand(w)?;
            }
            manager.save();
            emit(w, &manager.get(w));
            Ok(())
        }
        "dock-left" | "dock-right" | "dock-top" => {
            r.edge = Some(action.trim_start_matches("dock-").into());
            if !r.collapsed {
                r.expanded = Some(bounds(w)?);
            }
            manager.put(w, r);
            expand(w)?;
            manager.save();
            Ok(())
        }
        "undock" => {
            r.edge = None;
            manager.put(w, r.clone());
            expand(w)?;
            manager.save();
            emit(w, &r);
            Ok(())
        }
        "pointer-leave" => {
            blurred(w.clone());
            Ok(())
        }
        "anchor-drag-end" => {
            anchor_moved(w)?;
            Ok(())
        }
        "file-hover" => {
            r.file_hover = value.unwrap_or(false);
            manager.put(w, r);
            if !value.unwrap_or(false) {
                blurred(w.clone());
            }
            Ok(())
        }
        "upload-busy" => {
            r.upload_busy = value.unwrap_or(false);
            manager.put(w, r);
            if !value.unwrap_or(false) {
                blurred(w.clone());
            }
            Ok(())
        }
        "collapse" => collapse(w),
        "expand" => expand(w),
        "busy" => {
            r.busy = value.unwrap_or(true);
            if !r.busy {
                r.layout_until = None;
            }
            manager.put(w, r);
            if value == Some(false) {
                resized(w);
            }
            Ok(())
        }
        _ => Err("未知贴边操作".into()),
    }
}
fn suppressed(r: &Record) -> bool {
    r.layout_until
        .is_some_and(|until| std::time::Instant::now() < until)
}
pub fn expand(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    let mut b = if r.collapsed {
        r.expanded.unwrap_or(bounds(w)?)
    } else {
        bounds(w)?
    };
    let anchor = w.app_handle().get_webview_window(&anchor_label(w));
    let mut monitor = w.current_monitor().map_err(|e| e.to_string())?;
    if let Some(anchor) = &anchor {
        if anchor.is_visible().unwrap_or(false) {
            monitor = anchor
                .current_monitor()
                .map_err(|e| e.to_string())?
                .or(monitor);
        }
    }
    let mut ab = None;
    if let Some(m) = monitor {
        let area = m.work_area();
        let depth = (56. * m.scale_factor()).round() as u32;
        let gap = (8. * m.scale_factor()).round() as i32;
        let offset = depth as i32 + gap;
        b.width = b.width.min(area.size.width.saturating_sub(
            if r.edge.as_deref() == Some("top") || r.edge.is_none() {
                0
            } else {
                offset as u32
            },
        ));
        b.height = b.height.min(area.size.height.saturating_sub(
            if r.edge.as_deref() == Some("top") {
                offset as u32
            } else {
                0
            },
        ));
        let mut animal = Bounds {
            x: b.x + (b.width as i32 - depth as i32) / 2,
            y: b.y,
            width: depth,
            height: depth,
        };
        if let Some(anchor) = &anchor {
            if anchor.is_visible().unwrap_or(false) {
                if let Ok(p) = anchor.outer_position() {
                    animal.x = p.x;
                    animal.y = p.y;
                }
            }
        }
        match r.edge.as_deref() {
            Some("left") => {
                animal.x = area.position.x;
                b.x = animal.x + offset;
                b.y = animal.y;
            }
            Some("right") => {
                animal.x = area.position.x + area.size.width as i32 - depth as i32;
                b.x = animal.x - gap - b.width as i32;
                b.y = animal.y;
            }
            Some("top") => {
                animal.y = area.position.y;
                b.x = animal.x + (depth as i32 - b.width as i32) / 2;
                b.y = animal.y + offset;
            }
            _ => {}
        }
        b.x = b.x.clamp(
            area.position.x,
            area.position.x + area.size.width as i32 - b.width as i32,
        );
        b.y = b.y.clamp(
            area.position.y,
            area.position.y + area.size.height as i32 - b.height as i32,
        );
        animal.x = animal.x.clamp(
            area.position.x,
            area.position.x + area.size.width as i32 - depth as i32,
        );
        animal.y = animal.y.clamp(
            area.position.y,
            area.position.y + area.size.height as i32 - depth as i32,
        );
        if r.edge.is_some() {
            ab = Some(animal);
        }
    }
    r.collapsed = false;
    r.expanded = Some(b);
    r.layout_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(250));
    manager.put(w, r.clone());
    w.set_min_size(Some(LogicalSize::new(360., 480.)))
        .map_err(|e| e.to_string())?;
    w.set_resizable(true).map_err(|e| e.to_string())?;
    apply(w, b)?;
    if let Some(ab) = ab {
        show_anchor(w, ab)?;
    } else if let Some(anchor) = anchor {
        let _ = anchor.hide();
    }
    w.set_always_on_top(r.pinned).map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    emit(w, &r);
    manager.save();
    Ok(())
}
pub fn anchor_moved(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if suppressed(&r) {
        return Ok(());
    }
    let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) else {
        return Ok(());
    };
    let p = anchor.outer_position().map_err(|e| e.to_string())?;
    if let Some(m) = anchor.current_monitor().map_err(|e| e.to_string())? {
        let a = m.work_area();
        let size = anchor.inner_size().map_err(|e| e.to_string())?;
        let edges = [
            ("left", (p.x - a.position.x).abs()),
            (
                "right",
                (p.x + size.width as i32 - a.position.x - a.size.width as i32).abs(),
            ),
            ("top", (p.y - a.position.y).abs()),
        ];
        let (edge, distance) = edges.iter().min_by_key(|(_, distance)| distance).unwrap();
        r.edge = if *distance <= (24. * m.scale_factor()) as i32 {
            Some((*edge).into())
        } else {
            None
        };
        if let Some(mut b) = r.expanded {
            b.x = p.x;
            b.y = p.y;
            r.expanded = Some(b);
        }
        if r.edge.is_none() {
            r.collapsed = true;
        }
        manager.put(w, r.clone());
        if r.edge.is_none() || !r.collapsed {
            expand(w)?;
        }
        manager.save();
    }
    Ok(())
}
pub fn collapse(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if r.collapsed || r.pinned || r.busy || r.upload_busy || r.file_hover || r.edge.is_none() {
        return Ok(());
    }
    let Some(m) = w.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let area = m.work_area();
    let scale = m.scale_factor();
    let depth = (56. * scale) as u32;
    let span = depth;
    let mut b = bounds(w)?;
    r.expanded = Some(b);
    match r.edge.as_deref() {
        Some("left") => {
            b.x = area.position.x;
            b.width = depth;
            b.height = span;
        }
        Some("right") => {
            b.x = area.position.x + area.size.width as i32 - depth as i32;
            b.width = depth;
            b.height = span;
        }
        Some("top") => {
            b.y = area.position.y;
            b.width = span;
            b.height = depth;
        }
        _ => return Ok(()),
    }
    b.x = b.x.clamp(
        area.position.x,
        area.position.x + area.size.width as i32 - b.width as i32,
    );
    b.y = b.y.clamp(
        area.position.y,
        area.position.y + area.size.height as i32 - b.height as i32,
    );
    r.collapsed = true;
    manager.put(w, r.clone());
    if let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) {
        anchor.show().map_err(|e| e.to_string())?;
    } else {
        show_anchor(w, b)?;
    }
    w.hide().map_err(|e| e.to_string())?;
    emit(w, &r);
    manager.save();
    Ok(())
}
pub fn resized(w: &WebviewWindow) {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if r.collapsed || r.busy || suppressed(&r) {
        return;
    }
    if let Ok(b) = bounds(w) {
        r.expanded = Some(b);
        manager.put(w, r);
        manager.save();
    }
}
pub fn moved(w: &WebviewWindow) {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if r.collapsed || r.busy || suppressed(&r) {
        return;
    }
    if let (Ok(b), Ok(Some(m))) = (bounds(w), w.current_monitor()) {
        let a = m.work_area();
        let margin = (24. * m.scale_factor()) as i32;
        let offset = (64. * m.scale_factor()) as i32;
        r.edge = if (b.x - a.position.x).abs() < margin
            || (r.edge.as_deref() == Some("left") && (b.x - a.position.x - offset).abs() < margin)
        {
            Some("left".into())
        } else if (b.x + b.width as i32 - a.position.x - a.size.width as i32).abs() < margin
            || (r.edge.as_deref() == Some("right")
                && (b.x + b.width as i32 - a.position.x - a.size.width as i32 + offset).abs()
                    < margin)
        {
            Some("right".into())
        } else if (b.y - a.position.y).abs() < margin
            || (r.edge.as_deref() == Some("top") && (b.y - a.position.y - offset).abs() < margin)
        {
            Some("top".into())
        } else {
            None
        };
        r.expanded = Some(b);
        manager.put(w, r.clone());
        emit(w, &r);
        manager.save();
        if r.edge.is_none() {
            if let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) {
                let _ = anchor.hide();
            }
        } else {
            let w = w.clone();
            tauri::async_runtime::spawn(async move {
                let _ = expand(&w);
            });
        }
    }
}
pub fn pointer_inside(w: &WebviewWindow) -> bool {
    let Ok(p) = w.cursor_position() else {
        return true;
    };
    let gap = 8. * w.scale_factor().unwrap_or(1.);
    [
        Some(w.clone()),
        w.app_handle().get_webview_window(&anchor_label(w)),
    ]
    .into_iter()
    .flatten()
    .any(|window| {
        if !window.is_visible().unwrap_or(false) {
            return false;
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            return false;
        };
        p.x >= position.x as f64 - gap
            && p.x <= position.x as f64 + size.width as f64 + gap
            && p.y >= position.y as f64 - gap
            && p.y <= position.y as f64 + size.height as f64 + gap
    })
}
pub fn blurred(w: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        if w.is_visible().unwrap_or(false) && !pointer_inside(&w) {
            let _ = collapse(&w);
        }
    });
}
