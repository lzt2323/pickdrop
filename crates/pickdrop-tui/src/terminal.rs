//! Bounded terminal rendering and input; no network or protocol implementation.
use crate::app::{self, App};
use anyhow::{Context, Result};
use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{
        DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyCode, KeyEventKind,
        KeyModifiers,
    },
    execute, queue,
    style::Print,
    terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use pickdrop_core::{
    protocol::{random, s},
    Core,
};
use serde_json::{json, Value};
use std::{
    io::{stdout, Write},
    path::Path,
    time::{Duration, Instant},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

struct Screen;
impl Screen {
    fn enter() -> Result<Self> {
        terminal::enable_raw_mode()?;
        let screen = Self;
        execute!(stdout(), EnterAlternateScreen, EnableBracketedPaste, Hide)?;
        Ok(screen)
    }
}
impl Drop for Screen {
    fn drop(&mut self) {
        let _ = execute!(stdout(), DisableBracketedPaste, Show, LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
    }
}
#[derive(Default)]
struct Editor {
    text: String,
    cursor: usize,
}
impl Editor {
    fn insert(&mut self, value: &str) -> Result<()> {
        let clean: String = value
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        anyhow::ensure!(
            self.text.len() + clean.len() <= 16 * 1024,
            "输入超过 16 KiB，原内容已保留"
        );
        self.text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
        Ok(())
    }
    fn left(&mut self) {
        self.cursor = self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0);
    }
    fn right(&mut self) {
        self.cursor += self.text[self.cursor..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(0);
    }
    fn backspace(&mut self) {
        let end = self.cursor;
        self.left();
        self.text.replace_range(self.cursor..end, "");
    }
    fn delete(&mut self) {
        let start = self.cursor;
        self.right();
        let end = self.cursor;
        self.cursor = start;
        self.text.replace_range(start..end, "");
    }
}
pub fn safe_text(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}
fn clip(text: &str, width: usize) -> String {
    let mut columns = 0;
    safe_text(text)
        .chars()
        .take_while(|c| {
            columns += c.width().unwrap_or(0);
            columns <= width
        })
        .collect()
}
fn wrapped(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![];
    }
    let mut lines = vec![];
    let mut line = String::new();
    let mut columns = 0;
    for c in safe_text(text).chars() {
        let size = c.width().unwrap_or(0);
        if columns + size > width {
            lines.push(std::mem::take(&mut line));
            columns = 0;
        }
        if size <= width {
            line.push(c);
            columns += size;
        }
    }
    lines.push(line);
    lines
}
struct Job {
    task: tokio::task::JoinHandle<Result<Value>>,
    method: String,
    draft: Option<String>,
    transfer: Option<String>,
}
fn start(
    core: &Core,
    method: &str,
    params: Value,
    draft: Option<String>,
    transfer: Option<String>,
) -> Job {
    let core = core.clone();
    let command = method.to_owned();
    Job {
        task: tokio::spawn(async move { app::dispatch(&core, &command, params).await }),
        method: method.into(),
        draft,
        transfer,
    }
}
async fn submit(
    core: &Core,
    app: &mut App,
    editor: &mut Editor,
    job: &mut Option<Job>,
) -> Result<bool> {
    let input = std::mem::take(&mut editor.text);
    editor.cursor = 0;
    if input.trim().is_empty() {
        return Ok(false);
    }
    if input.trim() == "/quit" {
        return Ok(true);
    }
    if input.trim() == "/help" {
        app.detail = Some(app::HELP.iter().map(|s| s.to_string()).collect());
        app.scroll = 0;
        return Ok(false);
    }
    if input.trim() == "/cancel" {
        let id = job
            .as_ref()
            .and_then(|job| job.transfer.as_deref())
            .context("当前没有可取消的文件传输")?;
        let result = core
            .dispatch("cancel_transfer", json!({"transferId":id}))
            .await?;
        app.notice = if result["ok"] == true {
            "已请求取消，等待传输清理"
        } else {
            "传输尚未开始或已经完成，请检查结果"
        }
        .into();
        return Ok(false);
    }
    if job.is_some() {
        editor.text = input;
        editor.cursor = editor.text.len();
        anyhow::bail!("操作进行中，可使用 /cancel 或 Ctrl+C");
    }
    app.scroll = 0;
    app.detail = None;
    match input.trim() {
        "/groups" => {
            app.detail = Some(
                app.groups()
                    .iter()
                    .enumerate()
                    .map(|(i, g)| format!("{} {}  {}", i + 1, s(g, "name"), s(g, "id")))
                    .collect(),
            )
        }
        "/discard" => {
            let draft = app.current_draft()?;
            app.remove_draft(&draft.id)?;
            app.notice = "附件已移除".into();
        }
        "/send" => {
            let draft = app.current_draft()?;
            let id = random(12);
            *job = Some(start(
                core,
                "send_file",
                json!({"groupId":draft.group,"path":draft.path,"transferId":id}),
                Some(draft.id),
                Some(id),
            ));
            app.notice = "正在发送附件… /cancel 可取消".into();
        }
        value if value.starts_with("/file ") => app.stage(value.strip_prefix("/file ").unwrap())?,
        _ => {
            let (method, mut params) = app::command(app, &input)?;
            let transfer = if method == "save_file" {
                let id = random(12);
                params["transferId"] = json!(id);
                Some(id)
            } else {
                None
            };
            *job = Some(start(core, &method, params, None, transfer));
            app.notice = format!("正在处理 {method}…");
        }
    }
    Ok(false)
}
fn render(app: &App, editor: &Editor, busy: bool) -> Result<()> {
    let (width, height) = terminal::size()?;
    let w = width as usize;
    let h = height as usize;
    let mut output = stdout();
    queue!(output, Hide, MoveTo(0, 0), Clear(ClearType::All))?;
    if w < 36 || h < 10 {
        queue!(
            output,
            Print(clip("终端至少需要 36 列 × 10 行，请调整窗口", w))
        )?;
        output.flush()?;
        return Ok(());
    }
    let name = app
        .groups()
        .iter()
        .find(|g| g["id"] == app.boot["activeGroupId"])
        .map(|g| s(g, "name"))
        .unwrap_or("尚未加入群组");
    let online = app.state["devices"]
        .as_array()
        .map(|devices| devices.iter().filter(|d| d["online"] == true).count())
        .unwrap_or(0);
    let heading = format!(
        "拾传 {} | {} | {} 在线{}",
        env!("CARGO_PKG_VERSION"),
        name,
        online,
        if busy { " | 处理中" } else { "" }
    );
    queue!(
        output,
        Print(clip(&heading, w)),
        MoveTo(0, 1),
        Print(clip(
            &format!(
                "设备 {} | {}",
                s(&app.boot["device"], "name"),
                s(&app.boot["endpoint"], "baseUrl")
            ),
            w
        ))
    )?;
    let mut lines = Vec::new();
    if let Some(detail) = &app.detail {
        for line in detail {
            lines.extend(wrapped(line, w));
        }
    } else if let Some(messages) = app.state["messages"].as_array() {
        for message in messages {
            lines.extend(wrapped(
                &format!("{} [{}]", s(message, "senderName"), s(message, "id")),
                w,
            ));
            lines.extend(wrapped(
                if message["type"] == "file" {
                    s(message, "fileName")
                } else {
                    s(message, "text")
                },
                w,
            ));
        }
    }
    if lines.is_empty() {
        lines.push("暂无消息；/create 群名 或 /join 邀请链接".into());
    }
    let area = h - 7;
    let end = lines
        .len()
        .saturating_sub(app.scroll.min(lines.len().saturating_sub(1)));
    let start = end.saturating_sub(area);
    for (row, line) in lines[start..end].iter().enumerate() {
        queue!(output, MoveTo(0, (row + 3) as u16), Print(line))?;
    }
    let draft = app
        .current_draft()
        .ok()
        .map(|draft| {
            format!(
                "待发送：{}  /send 确认  /discard 移除",
                draft
                    .path
                    .file_name()
                    .unwrap_or(draft.path.as_os_str())
                    .to_string_lossy()
            )
        })
        .unwrap_or_else(|| "/help 命令 | Tab 切群 | ↑↓ 滚动 | Ctrl+C 退出（保留草稿）".into());
    queue!(
        output,
        MoveTo(0, height - 3),
        Print(clip(&draft, w)),
        MoveTo(0, height - 2),
        Print(clip(&app.notice, w))
    )?;
    let mut offset = 0;
    while UnicodeWidthStr::width(&editor.text[offset..editor.cursor]) > w - 3 {
        offset += editor.text[offset..].chars().next().unwrap().len_utf8();
    }
    let visible = clip(&editor.text[offset..], w - 2);
    let column = 2 + UnicodeWidthStr::width(&editor.text[offset..editor.cursor]);
    queue!(
        output,
        MoveTo(0, height - 1),
        Print("> "),
        Print(visible),
        MoveTo(column.min(w - 1) as u16, height - 1),
        Show
    )?;
    output.flush()?;
    Ok(())
}
pub async fn run(core: &Core, data: &Path) -> Result<()> {
    let mut app = App::open(data)?;
    app.refresh(core).await?;
    let _screen = Screen::enter()?;
    let old_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(stdout(), DisableBracketedPaste, Show, LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
        old_hook(info);
    }));
    let mut editor = Editor::default();
    let mut job: Option<Job> = None;
    let mut keys = EventStream::new();
    let mut events = core.subscribe();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let mut last_refresh = Instant::now();
    let mut dirty = true;
    let mut refresh = false;
    loop {
        tokio::select! {
            input=keys.next() => match input {
                Some(Ok(Event::Key(key))) if key.kind!=KeyEventKind::Release => {
                    dirty=true;
                    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code==KeyCode::Char('c') { break; }
                    match key.code {
                        KeyCode::Char(c) if !key.modifiers.intersects(KeyModifiers::CONTROL|KeyModifiers::ALT) => { if let Err(error)=editor.insert(&c.to_string()){app.notice=error.to_string();} },
                        KeyCode::Backspace=>editor.backspace(), KeyCode::Delete=>editor.delete(),
                        KeyCode::Left=>editor.left(), KeyCode::Right=>editor.right(), KeyCode::Home=>editor.cursor=0, KeyCode::End=>editor.cursor=editor.text.len(),
                        KeyCode::Up=>app.scroll=app.scroll.saturating_add(1), KeyCode::Down=>app.scroll=app.scroll.saturating_sub(1),
                        KeyCode::PageUp=>app.scroll=app.scroll.saturating_add(10), KeyCode::PageDown=>app.scroll=app.scroll.saturating_sub(10),
                        KeyCode::Esc=>{ app.detail=None; app.scroll=0; },
                        KeyCode::Tab if job.is_none() && !app.groups().is_empty()=> {
                            app.detail=None; app.scroll=0;
                            let index=app.groups().iter().position(|g|g["id"]==app.boot["activeGroupId"]).unwrap_or(0);
                            job=Some(start(core,"select_group",json!({"id":app.groups()[(index+1)%app.groups().len()]["id"]}),None,None));
                        }
                        KeyCode::Enter=>match submit(core,&mut app,&mut editor,&mut job).await {Ok(true)=>break,Ok(false)=>{},Err(error)=>app.notice=format!("错误：{error:#}")},
                        _=>{}
                    }
                }
                Some(Ok(Event::Paste(text)))=>{if let Err(error)=editor.insert(&text){app.notice=error.to_string();}dirty=true;}
                Some(Ok(Event::Resize(..)))=>dirty=true,
                Some(Err(error))=>return Err(error.into()), None=>break, _=>{}
            },
            result=async {match job.as_mut(){Some(job)=>(&mut job.task).await,None=>std::future::pending().await}} => {
                let finished=job.take().unwrap();
                match result.context("操作任务终止").and_then(|result|result) {
                    Ok(value)=>{
                        app.notice="操作完成".into();
                        if let Some(id)=finished.draft { if let Err(error)=app.remove_draft(&id){app.notice=format!("已发送，但草稿清理失败，请勿重复发送：{error}");} }
                        if matches!(finished.method.as_str(),"create_invite"|"list_join_requests"|"get_state"|"save_file") {app.detail=Some(serde_json::to_string_pretty(&value)?.lines().map(str::to_owned).collect());}
                        if finished.method=="join_group" {app.notice="申请已提交，核心会继续等待批准；无需保持此面板".into();}
                    }
                    Err(error)=>app.notice=format!("错误：{error:#}；未发附件保留"),
                }
                refresh=true;dirty=true;
            },
            event=events.recv()=>match event {
                Ok(value)=>{
                    if value["type"]=="transfer" && job.as_ref().and_then(|j|j.transfer.as_deref())==value["id"].as_str() {
                        app.notice=format!("传输 {} {} / {} 字节",s(&value,"status"),value["bytes"],value["total"]); dirty=true;
                    } else {refresh=true;}
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>refresh=true,
                Err(tokio::sync::broadcast::error::RecvError::Closed)=>break,
            },
            _=tick.tick()=>{
                if refresh || last_refresh.elapsed()>=Duration::from_secs(1) { dirty|=app.refresh(core).await?;refresh=false;last_refresh=Instant::now(); }
                if dirty {render(&app,&editor,job.is_some())?;dirty=false;}
            }
        }
    }
    if let Some(mut job) = job {
        if let Some(id) = job.transfer {
            let _ = core
                .dispatch("cancel_transfer", json!({"transferId":id}))
                .await;
        }
        if tokio::time::timeout(Duration::from_secs(2), &mut job.task)
            .await
            .is_err()
        {
            job.task.abort();
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_names_cannot_write_terminal_escape_sequences() {
        let text = "file\x1b[2J\n\u{009b}31m";
        assert!(!safe_text(text).chars().any(char::is_control));
        assert_eq!(clip("中文abc", 5), "中文a");
        assert_eq!(wrapped("中文abc", 4), vec!["中文", "abc"]);
    }
    #[test]
    fn editing_preserves_utf8_boundaries_and_paste_does_not_execute_lines() {
        let mut editor = Editor::default();
        editor.insert("你好a").unwrap();
        editor.left();
        editor.backspace();
        assert_eq!(editor.text, "你a");
        editor.delete();
        assert_eq!(editor.text, "你");
        editor.insert("\n/quit\x1b").unwrap();
        assert_eq!(editor.text, "你 /quit ");
        let previous = editor.text.clone();
        assert!(editor.insert(&"x".repeat(16 * 1024)).is_err());
        assert_eq!(editor.text, previous);
    }
}
