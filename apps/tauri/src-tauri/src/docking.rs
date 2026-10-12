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
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

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
    #[serde(skip)]
    busy: bool,
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
    let _ = w.emit(
        "pickdrop:window",
        serde_json::json!({"edge":r.edge,"collapsed":r.collapsed,"pinned":r.pinned}),
    );
}
fn apply(w: &WebviewWindow, b: Bounds) -> Result<(), String> {
    w.set_position(PhysicalPosition::new(b.x, b.y))
        .map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new(b.width, b.height))
        .map_err(|e| e.to_string())
}
pub fn restore(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    r.collapsed = false;
    manager.put(w, r.clone());
    if let Some(b) = r.expanded {
        apply(w, b)?;
    }
    w.set_always_on_top(r.pinned).map_err(|e| e.to_string())?;
    emit(w, &r);
    Ok(())
}
pub fn action(w: &WebviewWindow, action: &str, value: Option<bool>) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    match action {
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
            r.expanded = Some(bounds(w)?);
            manager.put(w, r);
            expand(w)?;
            manager.save();
            Ok(())
        }
        "undock" => {
            expand(w)?;
            r = manager.get(w);
            r.edge = None;
            manager.put(w, r.clone());
            manager.save();
            emit(w, &r);
            Ok(())
        }
        "collapse" => collapse(w),
        "expand" => expand(w),
        "busy" => {
            r.busy = value.unwrap_or(true);
            manager.put(w, r);
            Ok(())
        }
        _ => Err("未知贴边操作".into()),
    }
}
pub fn expand(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    let mut b = r.expanded.unwrap_or(bounds(w)?);
    if let Some(m) = w.current_monitor().map_err(|e| e.to_string())? {
        let area = m.work_area();
        b.width = b.width.min(area.size.width);
        b.height = b.height.min(area.size.height);
        b.x = b.x.clamp(
            area.position.x,
            area.position.x + area.size.width as i32 - b.width as i32,
        );
        b.y = b.y.clamp(
            area.position.y,
            area.position.y + area.size.height as i32 - b.height as i32,
        );
        match r.edge.as_deref() {
            Some("left") => b.x = area.position.x,
            Some("right") => b.x = area.position.x + area.size.width as i32 - b.width as i32,
            Some("top") => b.y = area.position.y,
            _ => {}
        }
    }
    r.collapsed = false;
    r.expanded = Some(b);
    manager.put(w, r.clone());
    w.set_min_size(Some(PhysicalSize::new(1, 1)))
        .map_err(|e| e.to_string())?;
    w.set_decorations(true).map_err(|e| e.to_string())?;
    w.set_resizable(true).map_err(|e| e.to_string())?;
    apply(w, b)?;
    w.set_always_on_top(r.pinned).map_err(|e| e.to_string())?;
    emit(w, &r);
    Ok(())
}
pub fn collapse(w: &WebviewWindow) -> Result<(), String> {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if r.collapsed || r.pinned || r.busy || r.edge.is_none() {
        return Ok(());
    }
    let Some(m) = w.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let area = m.work_area();
    let scale = m.scale_factor();
    let depth = (40. * scale) as u32;
    let span = (64. * scale) as u32;
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
    w.set_min_size(Some(PhysicalSize::new(1, 1)))
        .map_err(|e| e.to_string())?;
    w.set_decorations(false).map_err(|e| e.to_string())?;
    w.set_resizable(false).map_err(|e| e.to_string())?;
    w.set_always_on_top(true).map_err(|e| e.to_string())?;
    apply(w, b)?;
    emit(w, &r);
    manager.save();
    Ok(())
}
pub fn moved(w: &WebviewWindow) {
    let manager = w.state::<Docking>();
    let mut r = manager.get(w);
    if r.collapsed || r.busy {
        return;
    }
    if let (Ok(b), Ok(Some(m))) = (bounds(w), w.current_monitor()) {
        let a = m.work_area();
        let margin = (24. * m.scale_factor()) as i32;
        r.edge = if (b.x - a.position.x).abs() < margin {
            Some("left".into())
        } else if (b.x + b.width as i32 - a.position.x - a.size.width as i32).abs() < margin {
            Some("right".into())
        } else if (b.y - a.position.y).abs() < margin {
            Some("top".into())
        } else {
            None
        };
        r.expanded = Some(b);
        manager.put(w, r.clone());
        emit(w, &r);
    }
}
pub fn blurred(w: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        if !w.is_focused().unwrap_or(true) {
            let _ = collapse(&w);
        }
    });
}
