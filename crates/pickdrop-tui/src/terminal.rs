//! Terminal lifecycle and async event loop; rendering and interactions stay separate.
use crate::app::App;
use crate::interaction::{key_action, result_lines, Job};
use crate::view::{render, Editor};
use crate::workspace::{Focus, FormKind, Workspace};
use anyhow::{Context, Result};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyCode, KeyEventKind,
        KeyModifiers,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use pickdrop_core::{protocol::s, Core};
use serde_json::json;
use std::{
    io::stdout,
    path::Path,
    time::{Duration, Instant},
};
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
pub async fn run(core: &Core, data: &Path, listen_override: Option<String>) -> Result<bool> {
    let mut app = App::open(data)?;
    app.listen_override = listen_override;
    app.refresh(core).await?;
    let _screen = Screen::enter()?;
    let old_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(stdout(), DisableBracketedPaste, Show, LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
        old_hook(info);
    }));
    let mut editor = Editor::default();
    let mut ui = Workspace::new()?;
    ui.select_latest_message(&app);
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
                    if ui.focus==Focus::Input && key.modifiers==KeyModifiers::CONTROL && key.code==KeyCode::Char('u') {editor=Editor::default();}
                    if !key.modifiers.intersects(KeyModifiers::CONTROL|KeyModifiers::ALT) {
                        match key_action(core,&mut app,&mut ui,&mut editor,&mut job,key.code).await {
                            Ok(true)=>break,Ok(false)=>{},Err(error)=>app.notice=format!("错误：{error:#}")
                        }
                    }
                }
                Some(Ok(Event::Paste(text)))=>{
                    if ui.confirmation.is_none() {
                        if ui.focus!=Focus::Input {ui.open_form("粘贴内容；Enter 提交 · Esc 取消",FormKind::Command);editor=Editor::default();}
                        if let Err(error)=editor.insert(&text){app.notice=error.to_string();}
                    }
                    dirty=true;
                }

                Some(Ok(Event::Resize(..)))=>dirty=true,
                Some(Err(error))=>return Err(error.into()), None=>break, _=>{}
            },
            result=async {match job.as_mut(){Some(job)=>(&mut job.task).await,None=>std::future::pending().await}} => {
                let finished=job.take().unwrap();
                match result.context("操作任务终止").and_then(|result|result) {
                    Ok(value)=>{
                        app.notice="操作完成".into();
                        if let Some(id)=finished.draft { if let Err(error)=app.remove_draft(&id){app.notice=format!("已发送，但草稿清理失败，请勿重复发送：{error}");} }
                        if matches!(finished.method.as_str(),"create_invite"|"list_join_requests"|"get_state"|"save_file"|"storage_stats") && ui.accepts_result(finished.menu) {
                            app.detail=Some(result_lines(&finished.method,&value));app.scroll=0;ui.focus=Focus::Content;
                        }
                        if matches!(finished.method.as_str(),"select_group"|"create_group") {app.detail=None;app.scroll=0;ui.selected=None;}
                        if finished.transfer.is_some(){ui.transfer=if finished.method=="send_file" {"本机文件已准备；未确认其他设备接收"} else {"文件已校验并保存到本机"}.into();}
                        if finished.method=="clear_cache" {app.notice="缓存已清理；身份、群组和聊天记录保留".into();ui.transfer="本机文件缓存已清理；其他设备可能无法下载原副本".into();}
                        if finished.method=="join_group" {app.notice="申请已提交，核心会继续等待批准；无需保持此面板".into();}
                    }
                    Err(error)=>{app.notice=format!("错误：{error:#}；未发附件保留");if finished.transfer.is_some(){ui.transfer=app.notice.clone();}},
                }
                refresh=true;dirty=true;
            },
            event=events.recv()=>match event {
                Ok(value)=>{
                    if value["type"]=="transfer" && job.as_ref().and_then(|j|j.transfer.as_deref())==value["id"].as_str() {
                        app.notice=format!("传输 {} {} / {} 字节",s(&value,"status"),value["bytes"],value["total"]); ui.transfer=app.notice.clone(); dirty=true;
                    } else {refresh=true;}
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>refresh=true,
                Err(tokio::sync::broadcast::error::RecvError::Closed)=>break,
            },
            _=tick.tick()=>{
                if refresh || last_refresh.elapsed()>=Duration::from_secs(1) { dirty|=app.refresh(core).await?;ui.select_latest_message(&app);refresh=false;last_refresh=Instant::now(); }
                if dirty {render(&app,&editor,&ui,job.is_some())?;dirty=false;}
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
    Ok(ui.clear_chat_data)
}
