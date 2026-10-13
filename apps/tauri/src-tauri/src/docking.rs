//! Native edge docking. Window coordinates are physical pixels; monitor DPI is
//! applied only to the visible tab and snap threshold.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, LogicalSize, Manager, WebviewWindow};
#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

pub const PANEL_DEFAULT: (f64, f64) = (320., 420.);
pub const PANEL_MIN: (f64, f64) = (300., 360.);
pub const PANEL_MAX: (f64, f64) = (380., 520.);

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}
// Saved bounds use physical pixels; preserve mini sizes across DPI scaling.
fn mini_bounds(mut b: Bounds, scale: f64) -> Bounds {
    if b.width as f64 > PANEL_MAX.0 * scale || b.height as f64 > PANEL_MAX.1 * scale {
        b.width = (PANEL_DEFAULT.0 * scale).round() as u32;
        b.height = (PANEL_DEFAULT.1 * scale).round() as u32;
    }
    b.width = b.width.max((PANEL_MIN.0 * scale).round() as u32);
    b.height = b.height.max((PANEL_MIN.1 * scale).round() as u32);
    b
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Record {
    edge: Option<String>,
    expanded: Option<Bounds>,
    #[serde(default)]
    expanded_scale: Option<f64>,
    // Version 1 stores the complete OS frame, not a mix of frame origin/client size.
    #[serde(default)]
    geometry_version: u8,
    collapsed: bool,
    pinned: bool,
    #[serde(default = "default_animal")]
    animal: String,
    #[serde(skip)]
    busy: bool,
    #[serde(skip)]
    protections: HashSet<String>,
    #[serde(skip)]
    context: serde_json::Value,
    #[serde(skip)]
    drop_group: Option<String>,
    #[serde(skip)]
    upload_busy: bool,
    #[serde(skip)]
    file_drag_busy: bool,
    #[serde(skip)]
    file_hover: bool,
    #[serde(skip)]
    layout_until: Option<std::time::Instant>,
    #[serde(skip)]
    resize_center: Option<(i64, i64)>,
}
// Geometry snapshots must not overwrite interactions started by Core/native
// callbacks while geometry APIs were executing. These fields have atomic writers.
fn merge_runtime(mut snapshot: Record, current: &Record) -> Record {
    snapshot.protections = current.protections.clone();
    snapshot.context = current.context.clone();
    snapshot.file_hover = current.file_hover;
    snapshot.drop_group = current.drop_group.clone();
    snapshot
}
fn default_animal() -> String {
    "cat".into()
}

pub struct Docking {
    records: Mutex<HashMap<String, Record>>,
    path: PathBuf,
    writer: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
    // Separate per-owner interaction timers; never serialized with geometry.
    exit_generations: Mutex<HashMap<String, u64>>,
    exit_deadlines: Mutex<HashMap<String, (u64, std::time::Instant)>>,
    exit_workers: Mutex<HashSet<String>>,
    layout_generations: Mutex<HashMap<String, u64>>,
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
            exit_generations: Mutex::new(HashMap::new()),
            exit_deadlines: Mutex::new(HashMap::new()),
            exit_workers: Mutex::new(HashSet::new()),
            layout_generations: Mutex::new(HashMap::new()),
        }
    }
    fn next_exit_generation(&self, label: &str) -> u64 {
        self.exit_deadlines.lock().unwrap().remove(label);
        let mut generations = self.exit_generations.lock().unwrap();
        let generation = generations.entry(label.into()).or_default();
        *generation = generation.wrapping_add(1);
        *generation
    }
    fn is_current_exit(&self, label: &str, generation: u64) -> bool {
        self.exit_generations.lock().unwrap().get(label) == Some(&generation)
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
        let mut records = self.records.lock().unwrap();
        let r = records
            .get(w.label())
            .map_or_else(|| r.clone(), |current| merge_runtime(r.clone(), current));
        records.insert(w.label().into(), r);
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
    let s = w.outer_size().map_err(|e| e.to_string())?;
    Ok(Bounds {
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
    })
}
fn emit(w: &WebviewWindow, r: &Record) {
    let state = serde_json::json!({"owner":w.label(),"edge":r.edge,"collapsed":r.collapsed,"pinned":r.pinned});
    let _ = w.emit_to(w.label(), "pickdrop:window", &state);
    if let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) {
        let _ = w.emit_to(anchor.label(), "pickdrop:window", &state);
    }
}
pub fn context(w: &WebviewWindow, value: Option<serde_json::Value>) -> serde_json::Value {
    let manager = w.state::<Docking>();
    let mut records = manager.records.lock().unwrap();
    let r = records.entry(w.label().into()).or_default();
    if let Some(value) = value {
        r.context = value;
    }
    let mut value = r.context.clone();
    if !value.is_object() {
        value = serde_json::json!({});
    }
    value["owner"] = w.label().into();
    value
}
pub fn protection(w: &WebviewWindow, reason: &str, value: bool) {
    let manager = w.state::<Docking>();
    {
        let mut records = manager.records.lock().unwrap();
        let r = records.entry(w.label().into()).or_default();
        if value {
            r.protections.insert(reason.into());
        } else {
            r.protections.remove(reason);
        }
    }
    if value {
        manager.next_exit_generation(w.label());
    } else {
        if reason == "resize" {
            resized(w);
        }
        blurred(w.clone());
    }
}
pub fn file_hover(w: &WebviewWindow, value: bool) {
    let manager = w.state::<Docking>();
    {
        let mut records = manager.records.lock().unwrap();
        let r = records.entry(w.label().into()).or_default();
        if value && !r.file_hover {
            r.drop_group = r
                .context
                .get("groupId")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
        }
        r.file_hover = value;
    }
    if value {
        manager.next_exit_generation(w.label());
    } else {
        blurred(w.clone());
    }
}
pub fn drop_group(w: &WebviewWindow) -> Option<String> {
    let r = w.state::<Docking>().get(w);
    if r.file_hover {
        r.drop_group
    } else {
        r.context
            .get("groupId")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    }
}
// set_size accepts client dimensions, whereas docking, saved positions and
// screen fit must use the complete frame. Frameless macOS currently has zero
// inset, but Windows and changed native decorations need the same conversion.
fn frame_inset(w: &WebviewWindow) -> Result<(u32, u32), String> {
    let outer = w.outer_size().map_err(|e| e.to_string())?;
    let inner = w.inner_size().map_err(|e| e.to_string())?;
    Ok((
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    ))
}
fn apply(w: &WebviewWindow, b: Bounds) -> Result<(), String> {
    apply_at_scale(w, b, w.scale_factor().map_err(|e| e.to_string())?)
}
fn apply_at_scale(w: &WebviewWindow, b: Bounds, scale: f64) -> Result<(), String> {
    let (dx, dy) = frame_inset(w)?;
    #[cfg(target_os = "macos")]
    {
        // Cocoa uses global logical points. Physical positions are converted
        // using the current window DPI by Tao; that is the *old* screen during
        // an animal move to another monitor. Use the target monitor's points.
        w.set_size(LogicalSize::new(
            b.width.saturating_sub(dx).max(1) as f64 / scale,
            b.height.saturating_sub(dy).max(1) as f64 / scale,
        ))
        .map_err(|e| e.to_string())?;
        return w
            .set_position(tauri::LogicalPosition::new(
                b.x as f64 / scale,
                b.y as f64 / scale,
            ))
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        w.set_size(PhysicalSize::new(
            b.width.saturating_sub(dx).max(1),
            b.height.saturating_sub(dy).max(1),
        ))
        .map_err(|e| e.to_string())?;
        w.set_position(PhysicalPosition::new(b.x, b.y))
            .map_err(|e| e.to_string())
    }
}
fn work_area(m: &tauri::Monitor) -> Bounds {
    let a = m.work_area();
    Bounds {
        x: a.position.x,
        y: a.position.y,
        width: a.size.width,
        height: a.size.height,
    }
}
fn panel_monitor(w: &WebviewWindow) -> Result<Option<tauri::Monitor>, String> {
    w.current_monitor().map_err(|e| e.to_string())?.map_or_else(
        || w.primary_monitor().map_err(|e| e.to_string()),
        |m| Ok(Some(m)),
    )
}
fn constrain_panel(w: &WebviewWindow, area: Bounds, scale: f64) -> Result<(), String> {
    let (dx, dy) = frame_inset(w)?;
    // A smaller display/work area must lower native minimum constraints before
    // requesting a fitted size; otherwise the OS enlarges it after our clamp.
    let width = area.width.saturating_sub(dx).max(1) as f64 / scale;
    let height = area.height.saturating_sub(dy).max(1) as f64 / scale;
    w.set_min_size(Some(LogicalSize::new(
        PANEL_MIN.0.min(width),
        PANEL_MIN.1.min(height),
    )))
    .map_err(|e| e.to_string())?;
    w.set_max_size(Some(LogicalSize::new(
        PANEL_MAX.0.min(width),
        PANEL_MAX.1.min(height),
    )))
    .map_err(|e| e.to_string())
}
// Native setters enqueue macOS work. Re-read the actual frame after that work,
// fix any minimum/inset/DPI adjustment and save what the OS really applied.
// A newer layout/drag invalidates this worker, preventing stale corrections.
fn apply_panel(w: &WebviewWindow, target: Bounds, area: Bounds, scale: f64) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let generation = {
        let mut generations = manager.layout_generations.lock().unwrap();
        let next = generations.entry(w.label().into()).or_default();
        *next = next.wrapping_add(1);
        *next
    };
    apply_at_scale(w, target, scale)?;
    let w = w.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..3 {
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            let manager = w.state::<Docking>();
            if manager.layout_generations.lock().unwrap().get(w.label()) != Some(&generation) {
                return;
            }
            let mut r = manager.get(&w);
            if r.collapsed {
                return;
            }
            let Ok(actual) = bounds(&w) else {
                return;
            };
            // An older queued resize may still be visible. Keep the newest
            // requested dimensions authoritative rather than accepting that
            // intermediate frame and undoing the user's latest resize.
            if actual.width != target.width || actual.height != target.height {
                if apply_at_scale(&w, target, scale).is_err() {
                    return;
                }
                continue;
            }
            let fitted = expanded_bounds(actual, area, r.edge.as_deref());
            if actual != fitted || (actual.x, actual.y) != (target.x, target.y) {
                let fitted = expanded_bounds(target, area, r.edge.as_deref());
                if apply_at_scale(&w, fitted, scale).is_err() {
                    return;
                }
            } else {
                r.expanded = Some(actual);
                r.expanded_scale = w.scale_factor().ok();
                r.geometry_version = 1;
                manager.put(&w, r);
                manager.save();
                return;
            }
        }
    });
    Ok(())
}
pub fn begin_drag(w: &WebviewWindow) {
    let manager = w.state::<Docking>();
    let mut generations = manager.layout_generations.lock().unwrap();
    let generation = generations.entry(w.label().into()).or_default();
    *generation = generation.wrapping_add(1);
    drop(generations);
    let mut r = manager.get(w);
    r.layout_until = None;
    r.resize_center = None;
    manager.put(w, r);
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
        let _ = w.emit_to(
            anchor.label(),
            "pickdrop:animal",
            serde_json::json!({"owner":w.label(),"animal":r.animal}),
        );
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
    w.state::<Docking>().next_exit_generation(w.label());
    if let Some(anchor) = w.app_handle().get_webview_window(&anchor_label(w)) {
        anchor.hide().map_err(|e| e.to_string())?;
    }
    w.hide().map_err(|e| e.to_string())
}
fn show_anchor(w: &WebviewWindow, b: Bounds, scale: f64) -> Result<(), String> {
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
    apply_at_scale(&anchor, b, scale)?;
    anchor.show().map_err(|e| e.to_string())
}
pub fn restore(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    // Migrate previous large panels without changing their saved position.
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    if r.geometry_version == 0 {
        let (dx, dy) = frame_inset(w)?;
        if let Some(b) = &mut r.expanded {
            b.width += dx;
            b.height += dy;
        }
        r.geometry_version = 1;
    }
    if r.expanded_scale.is_none() {
        r.expanded_scale = Some(scale);
    }
    w.set_min_size(Some(LogicalSize::new(PANEL_MIN.0, PANEL_MIN.1)))
        .map_err(|e| e.to_string())?;
    w.set_max_size(Some(LogicalSize::new(PANEL_MAX.0, PANEL_MAX.1)))
        .map_err(|e| e.to_string())?;
    w.set_maximizable(false).map_err(|e| e.to_string())?;
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
            manager.save();
            emit(w, &manager.get(w));
            Ok(())
        }
        "dock-left" | "dock-right" | "dock-top" | "dock-bottom" => {
            r.edge = Some(action.trim_start_matches("dock-").into());
            if !r.collapsed {
                r.expanded = Some(bounds(w)?);
                r.expanded_scale = Some(w.scale_factor().map_err(|e| e.to_string())?);
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
            file_hover(w, value.unwrap_or(false));
            Ok(())
        }
        "upload-busy" | "file-drag-busy" => {
            if action == "upload-busy" {
                r.upload_busy = value.unwrap_or(false);
            } else {
                r.file_drag_busy = value.unwrap_or(false);
            }
            manager.put(w, r);
            if !value.unwrap_or(false) {
                blurred(w.clone());
            }
            Ok(())
        }
        "collapse" => collapse(w),
        "expand" => expand(w),
        "busy" => {
            if value.unwrap_or(true) {
                let mut generations = manager.layout_generations.lock().unwrap();
                let generation = generations.entry(w.label().into()).or_default();
                *generation = generation.wrapping_add(1);
            }
            r.busy = value.unwrap_or(true);
            if !r.busy {
                r.layout_until = None;
            }
            manager.put(w, r);
            if value == Some(false) {
                resized(w);
                blurred(w.clone());
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
    manager.next_exit_generation(w.label());
    let mut r = manager.get(w);
    let mut b = if r.collapsed {
        r.expanded.unwrap_or(bounds(w)?)
    } else {
        bounds(w)?
    };
    let source_scale = if r.collapsed {
        r.expanded_scale
            .unwrap_or(w.scale_factor().map_err(|e| e.to_string())?)
    } else {
        w.scale_factor().map_err(|e| e.to_string())?
    };
    let mut target_scale = source_scale;
    let anchor = w.app_handle().get_webview_window(&anchor_label(w));
    let mut monitor = panel_monitor(w)?;
    if let Some(anchor) = &anchor {
        if anchor.is_visible().unwrap_or(false) {
            monitor = anchor
                .current_monitor()
                .map_err(|e| e.to_string())?
                .or(monitor);
        }
    }
    let mut fitting_area = None;
    if let Some(m) = monitor {
        let area = m.work_area();
        fitting_area = Some(work_area(&m));
        constrain_panel(w, work_area(&m), m.scale_factor())?;
        target_scale = m.scale_factor();
        b = rescaled_bounds(b, source_scale, target_scale);
        let (dx, dy) = frame_inset(w)?;
        b.width = b.width.saturating_sub(dx);
        b.height = b.height.saturating_sub(dy);
        b = mini_bounds(b, target_scale);
        b.width += dx;
        b.height += dy;
        b = expanded_bounds(
            b,
            Bounds {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            },
            r.edge.as_deref(),
        );
    }
    r.collapsed = false;
    r.resize_center = None;
    r.expanded = Some(b);
    r.expanded_scale = Some(target_scale);
    r.layout_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(250));
    manager.put(w, r.clone());
    w.set_resizable(true).map_err(|e| e.to_string())?;
    if let Some(area) = fitting_area {
        apply_panel(w, b, area, target_scale)?;
    } else {
        apply(w, b)?;
    }
    if let Some(anchor) = anchor {
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
        let size = anchor.outer_size().map_err(|e| e.to_string())?;
        let edges = [
            ("left", (p.x - a.position.x).abs()),
            (
                "right",
                (p.x + size.width as i32 - a.position.x - a.size.width as i32).abs(),
            ),
            ("top", (p.y - a.position.y).abs()),
            (
                "bottom",
                (p.y + size.height as i32 - a.position.y - a.size.height as i32).abs(),
            ),
        ];
        let (edge, distance) = edges.iter().min_by_key(|(_, distance)| distance).unwrap();
        r.edge = if *distance <= (24. * m.scale_factor()) as i32 {
            Some((*edge).into())
        } else {
            None
        };
        if let Some(mut b) = r.expanded {
            b = rescaled_bounds(
                b,
                r.expanded_scale.unwrap_or(m.scale_factor()),
                m.scale_factor(),
            );
            r.expanded_scale = Some(m.scale_factor());
            let depth = (56. * m.scale_factor()).round() as i32;
            b.x = if r.edge.as_deref() == Some("right") {
                p.x + depth - b.width as i32
            } else {
                p.x + depth / 2 - b.width as i32 / 2
            };
            b.y = if r.edge.as_deref() == Some("bottom") {
                p.y + depth - b.height as i32
            } else {
                p.y + depth / 2 - b.height as i32 / 2
            };
            b = expanded_bounds(
                b,
                Bounds {
                    x: a.position.x,
                    y: a.position.y,
                    width: a.size.width,
                    height: a.size.height,
                },
                r.edge.as_deref(),
            );
            r.expanded = Some(b);
        }
        let was_collapsed = r.collapsed;
        if r.edge.is_none() {
            r.collapsed = true;
        }
        manager.put(w, r.clone());
        // Dragging a collapsed animal moves its saved panel position; it must
        // remain available as the restore target instead of opening mid-drag.
        if !was_collapsed {
            expand(w)?;
        }
        manager.save();
    }
    Ok(())
}
pub fn collapse(w: &WebviewWindow) -> Result<(), String> {
    collapse_for(w, true)
}
fn can_collapse(r: &Record, manual: bool) -> bool {
    !r.collapsed
        && r.protections.is_empty()
        && !r.busy
        && !r.upload_busy
        && !r.file_drag_busy
        && !r.file_hover
        && (manual || r.edge.is_some())
}
fn collapsed_bounds(panel: Bounds, area: Bounds, scale: f64, edge: Option<&str>) -> Bounds {
    let depth = ((56. * scale).round() as u32)
        .min(area.width)
        .min(area.height);
    let mut animal = Bounds {
        width: depth,
        height: depth,
        ..panel
    };
    match edge {
        Some("left") => {
            animal.x = area.x;
            animal.y = panel.y + (panel.height as i32 - depth as i32) / 2;
        }
        Some("right") => {
            animal.x = area.x + area.width as i32 - depth as i32;
            animal.y = panel.y + (panel.height as i32 - depth as i32) / 2;
        }
        Some("top") => {
            animal.y = area.y;
            animal.x = panel.x + (panel.width as i32 - depth as i32) / 2;
        }
        Some("bottom") => {
            animal.y = area.y + area.height as i32 - depth as i32;
            animal.x = panel.x + (panel.width as i32 - depth as i32) / 2;
        }
        _ => {}
    }
    animal.x = animal
        .x
        .clamp(area.x, area.x + area.width as i32 - depth as i32);
    animal.y = animal
        .y
        .clamp(area.y, area.y + area.height as i32 - depth as i32);
    animal
}
fn collapse_for(w: &WebviewWindow, manual: bool) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if !can_collapse(&r, manual) {
        return Ok(());
    }
    let Some(m) = panel_monitor(w)? else {
        return Ok(());
    };
    let area = m.work_area();
    let panel = bounds(w)?;
    let b = collapsed_bounds(
        panel,
        Bounds {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        m.scale_factor(),
        r.edge.as_deref(),
    );
    let previous = r.clone();
    manager.next_exit_generation(w.label());
    r.expanded = Some(panel);
    r.expanded_scale = Some(w.scale_factor().map_err(|e| e.to_string())?);
    r.collapsed = true;
    r.layout_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(250));
    manager.put(w, r.clone());
    // Show and position the restore target before hiding the panel. A failed
    // anchor creation leaves the original window available to the user.
    if let Err(error) = show_anchor(w, b, m.scale_factor()) {
        manager.put(w, previous);
        return Err(error);
    }
    if let Err(error) = w.hide() {
        manager.put(w, previous);
        return Err(error.to_string());
    }
    emit(w, &r);
    manager.save();
    Ok(())
}
/// Requested dimensions are logical client pixels. Free windows resize around
/// their center; docked windows keep the edge and center on the tangent axis.
pub fn resize(w: &WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    let current = bounds(w)?;
    let source = if suppressed(&r) {
        r.expanded.unwrap_or(current)
    } else {
        current
    };
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let (dx, dy) = frame_inset(w)?;
    let requested_width = (width.clamp(PANEL_MIN.0, PANEL_MAX.0) * scale).round() as u32 + dx;
    let requested_height = (height.clamp(PANEL_MIN.1, PANEL_MAX.1) * scale).round() as u32 + dy;
    let monitor = panel_monitor(w)?;
    let area = monitor.as_ref().map(work_area).unwrap_or(Bounds {
        x: i32::MIN / 2,
        y: i32::MIN / 2,
        width: i32::MAX as u32,
        height: i32::MAX as u32,
    });
    if let Some(m) = &monitor {
        constrain_panel(w, area, m.scale_factor())?;
    }
    let center = r.resize_center.unwrap_or((
        source.x as i64 * 2 + source.width as i64,
        source.y as i64 * 2 + source.height as i64,
    ));
    let b = centered_from(
        center,
        requested_width,
        requested_height,
        area,
        r.edge.as_deref(),
    );
    r.resize_center = Some(center);
    r.expanded = Some(b);
    r.expanded_scale = Some(scale);
    r.geometry_version = 1;
    r.layout_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(250));
    manager.next_exit_generation(w.label());
    manager.put(w, r);
    apply_panel(w, b, area, scale)?;
    manager.save();
    Ok(())
}
#[cfg(test)]
fn centered_bounds(
    source: Bounds,
    width: u32,
    height: u32,
    area: Bounds,
    edge: Option<&str>,
) -> Bounds {
    centered_from(
        (
            source.x as i64 * 2 + source.width as i64,
            source.y as i64 * 2 + source.height as i64,
        ),
        width,
        height,
        area,
        edge,
    )
}
fn centered_from(
    center: (i64, i64),
    width: u32,
    height: u32,
    area: Bounds,
    edge: Option<&str>,
) -> Bounds {
    let width = width.min(area.width);
    let height = height.min(area.height);
    expanded_bounds(
        Bounds {
            x: (center.0 - width as i64).div_euclid(2) as i32,
            y: (center.1 - height as i64).div_euclid(2) as i32,
            width,
            height,
        },
        area,
        edge,
    )
}
fn rescaled_bounds(mut b: Bounds, source: f64, target: f64) -> Bounds {
    let ratio = target / source;
    b.width = (b.width as f64 * ratio).round() as u32;
    b.height = (b.height as f64 * ratio).round() as u32;
    b
}
fn expanded_bounds(mut b: Bounds, area: Bounds, edge: Option<&str>) -> Bounds {
    b.width = b.width.min(area.width);
    b.height = b.height.min(area.height);
    match edge {
        Some("left") => b.x = area.x,
        Some("right") => b.x = area.x + area.width as i32 - b.width as i32,
        Some("top") => b.y = area.y,
        Some("bottom") => b.y = area.y + area.height as i32 - b.height as i32,
        _ => {}
    }
    b.x =
        b.x.clamp(area.x, area.x + area.width as i32 - b.width as i32);
    b.y =
        b.y.clamp(area.y, area.y + area.height as i32 - b.height as i32);
    b
}
fn detected_edge(b: Bounds, area: Bounds, scale: f64) -> Option<String> {
    let margin = (24. * scale).round() as i32;
    let candidates = [
        ("left", (b.x - area.x).max(0)),
        (
            "right",
            (area.x + area.width as i32 - b.x - b.width as i32).max(0),
        ),
        ("top", (b.y - area.y).max(0)),
        (
            "bottom",
            (area.y + area.height as i32 - b.y - b.height as i32).max(0),
        ),
    ];
    let (edge, distance) = candidates
        .into_iter()
        .min_by_key(|(_, distance)| *distance)?;
    (distance <= margin).then(|| edge.into())
}
pub fn resized(w: &WebviewWindow) {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if r.collapsed || r.busy || r.protections.contains("resize") || suppressed(&r) {
        return;
    }
    if let Ok(mut b) = bounds(w) {
        if let Ok(Some(m)) = w.current_monitor() {
            let a = m.work_area();
            b = expanded_bounds(
                b,
                Bounds {
                    x: a.position.x,
                    y: a.position.y,
                    width: a.size.width,
                    height: a.size.height,
                },
                r.edge.as_deref(),
            );
            if let Ok(current) = bounds(w) {
                if current != b {
                    r.layout_until =
                        Some(std::time::Instant::now() + std::time::Duration::from_millis(250));
                    manager.put(w, r.clone());
                    let _ = constrain_panel(w, work_area(&m), m.scale_factor());
                    let _ = apply_panel(w, b, work_area(&m), m.scale_factor());
                }
            }
        }
        r.resize_center = None;
        r.expanded = Some(b);
        r.expanded_scale = w.scale_factor().ok();
        manager.put(w, r);
        manager.save();
    }
}
pub fn moved(w: &WebviewWindow) {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if r.collapsed || r.busy || r.protections.contains("resize") || suppressed(&r) {
        return;
    }
    if let (Ok(b), Ok(Some(m))) = (bounds(w), panel_monitor(w)) {
        let mut generations = manager.layout_generations.lock().unwrap();
        let generation = generations.entry(w.label().into()).or_default();
        *generation = generation.wrapping_add(1);
        drop(generations);
        let a = m.work_area();
        r.resize_center = None;
        r.edge = detected_edge(
            b,
            Bounds {
                x: a.position.x,
                y: a.position.y,
                width: a.size.width,
                height: a.size.height,
            },
            m.scale_factor(),
        );
        r.expanded = Some(b);
        r.expanded_scale = Some(m.scale_factor());
        manager.put(w, r.clone());
        emit(w, &r);
        manager.save();
        // No geometry setters during native dragging: the cursor remains in
        // charge. Each move restarts inactivity grace independently per owner.
        blurred(w.clone());
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
    let manager = w.state::<Docking>();
    let generation = manager.next_exit_generation(w.label());
    manager.exit_deadlines.lock().unwrap().insert(
        w.label().into(),
        (
            generation,
            std::time::Instant::now() + std::time::Duration::from_millis(800),
        ),
    );
    // One coalescing worker per owner, even while native dragging emits many
    // Moved events. Expand/hide invalidate the deadline; a later leave can reuse
    // this worker without shortening its new grace period.
    if !manager
        .exit_workers
        .lock()
        .unwrap()
        .insert(w.label().into())
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let manager = w.state::<Docking>();
            let (generation, until) = {
                let deadlines = manager.exit_deadlines.lock().unwrap();
                let Some(next) = deadlines.get(w.label()).copied() else {
                    manager.exit_workers.lock().unwrap().remove(w.label());
                    return;
                };
                next
            };
            tokio::time::sleep(until.saturating_duration_since(std::time::Instant::now())).await;
            let manager = w.state::<Docking>();
            let mut deadlines = manager.exit_deadlines.lock().unwrap();
            if deadlines
                .get(w.label())
                .is_some_and(|(latest, _)| *latest == generation)
            {
                deadlines.remove(w.label());
                manager.exit_workers.lock().unwrap().remove(w.label());
                drop(deadlines);
                if manager.is_current_exit(w.label(), generation)
                    && w.is_visible().unwrap_or(false)
                    && !pointer_inside(&w)
                {
                    let _ = collapse_for(&w, false);
                }
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        can_collapse, centered_bounds, centered_from, collapsed_bounds, detected_edge,
        expanded_bounds, mini_bounds, rescaled_bounds, Bounds, Docking, Record,
    };

    #[test]
    fn protection_reasons_do_not_release_each_other() {
        let stale = Record::default();
        let mut current = stale.clone();
        current.protections.insert("native-transfer".into());
        current.file_hover = true;
        current.context = serde_json::json!({"groupId":"A"});
        current.drop_group = Some("A".into());
        let saved = super::merge_runtime(
            Record {
                pinned: true,
                ..stale
            },
            &current,
        );
        assert!(saved.pinned && saved.protections.contains("native-transfer") && saved.file_hover);
        assert_eq!(saved.context["groupId"], "A");
        assert_eq!(saved.drop_group.as_deref(), Some("A"));
        let mut r = Record {
            edge: Some("right".into()),
            ..Record::default()
        };
        r.protections
            .extend(["panel".into(), "file-picker".into(), "transfer".into()]);
        r.protections.remove("panel");
        assert!(!can_collapse(&r, false));
        r.protections.remove("file-picker");
        assert!(!can_collapse(&r, false));
        r.protections.remove("transfer");
        assert!(can_collapse(&r, false));
        r.file_hover = true;
        assert!(!can_collapse(&r, false));
        r.file_hover = false;
        assert!(can_collapse(&r, false));
    }
    #[test]
    fn pinned_only_controls_z_order_and_busy_panels_do_not_auto_collapse() {
        let mut record = Record::default();
        assert!(can_collapse(&record, true));
        assert!(!can_collapse(&record, false));
        record.edge = Some("right".into());
        assert!(can_collapse(&record, false));
        record.pinned = true;
        assert!(can_collapse(&record, true));
        assert!(can_collapse(&record, false));
        record.collapsed = true;
        assert!(!can_collapse(&record, true));
        record.collapsed = false;
        record.busy = true;
        assert!(!can_collapse(&record, true));
    }

    #[test]
    fn animal_remains_on_screen_for_free_position_edges_and_display_scales() {
        for scale in [1_f64, 1.5, 2.] {
            let area = Bounds {
                x: -1920,
                y: 24,
                width: 1920,
                height: 1080,
            };
            let panel = Bounds {
                x: -700,
                y: 300,
                width: 640,
                height: 840,
            };
            let depth = (56. * scale).round() as u32;
            let free = collapsed_bounds(panel, area, scale, None);
            assert_eq!((free.x, free.y), (panel.x, panel.y));
            assert_eq!((free.width, free.height), (depth, depth));
            for edge in [
                None,
                Some("left"),
                Some("right"),
                Some("top"),
                Some("bottom"),
            ] {
                let outside = Bounds {
                    x: 100,
                    y: 1300,
                    ..panel
                };
                let animal = collapsed_bounds(outside, area, scale, edge);
                assert!(animal.x >= area.x && animal.y >= area.y);
                assert!(animal.x + animal.width as i32 <= area.x + area.width as i32);
                assert!(animal.y + animal.height as i32 <= area.y + area.height as i32);
            }
        }
    }

    #[test]
    fn saved_panels_migrate_to_mini_at_each_display_scale() {
        for scale in [1., 1.5, 2.] {
            let bounds = |width: f64, height: f64| Bounds {
                x: 80,
                y: 100,
                width: (width * scale).round() as u32,
                height: (height * scale).round() as u32,
            };
            assert_eq!(mini_bounds(bounds(440., 720.), scale), bounds(320., 420.));
            assert_eq!(mini_bounds(bounds(2940., 1674.), scale), bounds(320., 420.));
            assert_eq!(mini_bounds(bounds(350., 470.), scale), bounds(350., 470.));
            assert_eq!(mini_bounds(bounds(280., 300.), scale), bounds(300., 360.));
        }
    }

    #[test]
    fn panel_geometry_stays_on_its_own_edge_at_each_display_scale() {
        for scale in [1_f64, 1.5, 2.] {
            let area = Bounds {
                x: -2560,
                y: 48,
                width: 2560,
                height: 1600,
            };
            let panel = Bounds {
                x: -1900,
                y: 260,
                width: (320. * scale) as u32,
                height: (420. * scale) as u32,
            };
            for edge in [
                Some("left"),
                Some("right"),
                Some("top"),
                Some("bottom"),
                None,
            ] {
                let before = expanded_bounds(panel, area, edge);
                let resized = centered_bounds(
                    before,
                    (350. * scale) as u32,
                    (470. * scale) as u32,
                    area,
                    edge,
                );
                match edge {
                    Some("left") => {
                        assert_eq!(resized.x, area.x);
                        assert!(
                            ((resized.y as i64 * 2 + resized.height as i64)
                                - (before.y as i64 * 2 + before.height as i64))
                                .abs()
                                <= 1
                        );
                    }
                    Some("right") => {
                        assert_eq!(resized.x + resized.width as i32, area.x + area.width as i32);
                        assert!(
                            ((resized.y as i64 * 2 + resized.height as i64)
                                - (before.y as i64 * 2 + before.height as i64))
                                .abs()
                                <= 1
                        );
                    }
                    Some("top") => {
                        assert_eq!(resized.y, area.y);
                        assert!(
                            ((resized.x as i64 * 2 + resized.width as i64)
                                - (before.x as i64 * 2 + before.width as i64))
                                .abs()
                                <= 1
                        );
                    }
                    Some("bottom") => {
                        assert_eq!(
                            resized.y + resized.height as i32,
                            area.y + area.height as i32
                        );
                        assert!(
                            ((resized.x as i64 * 2 + resized.width as i64)
                                - (before.x as i64 * 2 + before.width as i64))
                                .abs()
                                <= 1
                        );
                    }
                    _ => {
                        assert!(
                            ((resized.x as i64 * 2 + resized.width as i64)
                                - (before.x as i64 * 2 + before.width as i64))
                                .abs()
                                <= 1
                        );
                        assert!(
                            ((resized.y as i64 * 2 + resized.height as i64)
                                - (before.y as i64 * 2 + before.height as i64))
                                .abs()
                                <= 1
                        );
                    }
                }
                // Restore uses panel geometry and never adds animal depth/gap.
                assert_eq!(expanded_bounds(before, area, edge), before);
                if edge.is_some() {
                    assert_eq!(detected_edge(before, area, scale).as_deref(), edge);
                }
            }
            assert_eq!(detected_edge(panel, area, scale), None);
            let near = Bounds {
                x: area.x + (23. * scale) as i32,
                ..panel
            };
            assert_eq!(detected_edge(near, area, scale).as_deref(), Some("left"));
            assert_eq!(
                detected_edge(
                    Bounds {
                        x: area.x + (26. * scale) as i32,
                        ..panel
                    },
                    area,
                    scale
                ),
                None
            );
        }
    }
    #[test]
    fn crossed_edges_are_recognized_and_restore_fits_overshoot_corners() {
        for scale in [1_f64, 1.5, 2.] {
            for area in [
                Bounds {
                    x: -1920,
                    y: -1080,
                    width: 1920,
                    height: 1080,
                },
                Bounds {
                    x: 1200,
                    y: 28,
                    width: 1600,
                    height: 1000,
                },
                Bounds {
                    x: 0,
                    y: 24,
                    width: 240,
                    height: 280,
                },
            ] {
                let panel = Bounds {
                    x: area.x + 100,
                    y: area.y + 100,
                    width: (320. * scale) as u32,
                    height: (420. * scale) as u32,
                };
                for (edge, b) in [
                    (
                        "left",
                        Bounds {
                            x: area.x - 120,
                            ..panel
                        },
                    ),
                    (
                        "right",
                        Bounds {
                            x: area.x + area.width as i32 - panel.width as i32 + 120,
                            ..panel
                        },
                    ),
                    (
                        "top",
                        Bounds {
                            y: area.y - 120,
                            ..panel
                        },
                    ),
                    (
                        "bottom",
                        Bounds {
                            y: area.y + area.height as i32 - panel.height as i32 + 120,
                            ..panel
                        },
                    ),
                ] {
                    // Old absolute-distance detection rejected overshoots >24px.
                    if panel.width <= area.width && panel.height <= area.height {
                        assert_eq!(detected_edge(b, area, scale).as_deref(), Some(edge));
                    }
                    let restored = expanded_bounds(b, area, Some(edge));
                    assert!(restored.x >= area.x && restored.y >= area.y);
                    assert!(restored.x + restored.width as i32 <= area.x + area.width as i32);
                    assert!(restored.y + restored.height as i32 <= area.y + area.height as i32);
                }
            }
        }
    }
    #[test]
    fn center_resize_repeated_dimensions_and_small_workareas_remain_fitted() {
        for scale in [1_f64, 1.5, 2.] {
            let area = Bounds {
                x: -3000,
                y: -1200,
                width: 6000,
                height: 3600,
            };
            let start = Bounds {
                x: -900,
                y: -600,
                width: (320. * scale) as u32,
                height: (420. * scale) as u32,
            };
            let mut panel = start;
            for _ in 0..8 {
                for (width, height) in [(380., 520.), (300., 360.), (350., 470.), (320., 420.)] {
                    panel = centered_from(
                        (
                            start.x as i64 * 2 + start.width as i64,
                            start.y as i64 * 2 + start.height as i64,
                        ),
                        (width * scale).round() as u32,
                        (height * scale).round() as u32,
                        area,
                        None,
                    );
                    assert!(
                        ((panel.x as i64 * 2 + panel.width as i64)
                            - (start.x as i64 * 2 + start.width as i64))
                            .abs()
                            <= 1
                    );
                    assert!(
                        ((panel.y as i64 * 2 + panel.height as i64)
                            - (start.y as i64 * 2 + start.height as i64))
                            .abs()
                            <= 1
                    );
                }
            }
            let tiny = Bounds {
                x: 100,
                y: -280,
                width: 240,
                height: 280,
            };
            assert_eq!(centered_bounds(panel, 760, 1040, tiny, None), tiny);
        }
    }
    #[test]
    fn monitor_changes_preserve_logical_dimensions() {
        let panel = Bounds {
            x: -900,
            y: 160,
            width: 350,
            height: 470,
        };
        let retina = rescaled_bounds(panel, 1., 2.);
        assert_eq!((retina.width, retina.height), (700, 940));
        assert_eq!((retina.x, retina.y), (panel.x, panel.y));
        assert_eq!(rescaled_bounds(retina, 2., 1.), panel);
        assert_eq!(mini_bounds(retina, 2.), retina);
    }
    #[test]
    fn exit_generations_reject_old_timers_without_cancelling_other_windows() {
        let dir = tempfile::tempdir().unwrap();
        let docking = Docking::new(dir.path().join("windows.json"));
        let main_first = docking.next_exit_generation("main");
        let group_first = docking.next_exit_generation("group-other");
        let main_latest = docking.next_exit_generation("main");
        assert!(!docking.is_current_exit("main", main_first));
        assert!(docking.is_current_exit("main", main_latest));
        assert!(docking.is_current_exit("group-other", group_first));
        for _ in 0..32 {
            docking.next_exit_generation("main");
        }
        assert!(!docking.is_current_exit("main", main_latest));
        assert!(docking.is_current_exit("group-other", group_first));
        assert!(!docking.is_current_exit("unknown-window", 0));
    }
}
