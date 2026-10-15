//! Keyboard actions adapt workspace selections and forms to existing core commands.
use crate::app::{self, App};
use crate::view::Editor;
use crate::workspace::{Action, Focus, FormKind, Workspace, MENUS};
use anyhow::{Context, Result};
use crossterm::event::KeyCode;
use pickdrop_core::{
    protocol::{random, s},
    Core,
};
use serde_json::{json, Value};
pub(crate) struct Job {
    pub task: tokio::task::JoinHandle<Result<Value>>,
    pub method: String,
    pub menu: Option<usize>,
    pub draft: Option<String>,
    pub transfer: Option<String>,
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
        menu: None,
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
fn launch(
    core: &Core,
    ui: &Workspace,
    job: &mut Option<Job>,
    method: &str,
    params: Value,
) -> Result<()> {
    anyhow::ensure!(job.is_none(), "操作进行中，请等待完成或到传输菜单取消");
    let transfer = matches!(method, "send_file" | "save_file").then(|| random(12));
    let mut params = params;
    if let Some(id) = &transfer {
        params["transferId"] = json!(id);
    }
    let mut next = start(core, method, params, None, transfer);
    next.menu = Some(ui.menu);
    *job = Some(next);
    Ok(())
}
async fn activate(
    core: &Core,
    app: &mut App,
    ui: &mut Workspace,
    editor: &mut Editor,
    job: &mut Option<Job>,
    action: Action,
    confirmed: bool,
) -> Result<bool> {
    if !confirmed {
        let question = match &action {
            Action::Send(draft) => Some(format!(
                "发送附件到群 {}？\n{}",
                draft.group,
                draft.path.display()
            )),
            Action::Discard(_) => Some("移除当前群的未发送附件草稿？".into()),
            Action::Respond { group, id, allow } => Some(format!(
                "{}设备加入？申请 {}，群 {}",
                if *allow { "允许" } else { "拒绝" },
                id,
                group
            )),
            Action::Quit => Some("退出并停止本次同步服务？草稿和身份会保留。".into()),
            _ => None,
        };
        if let Some(question) = question {
            ui.confirmation = Some((question, action));
            ui.confirm_yes = false;
            return Ok(false);
        }
    }
    match action {
        Action::None => {}
        Action::Form(kind) => {
            if matches!(&kind,FormKind::Text(group)|FormKind::Connect(group)|FormKind::Path(group)|FormKind::Save{group,..} if group.is_empty())
            {
                anyhow::bail!("请先在菜单中新建或加入群");
            }
            let title = match &kind {
                FormKind::Text(_) => "输入文字，Enter 发送到当前群",
                FormKind::Create => "输入新群名称",
                FormKind::Join => "粘贴完整邀请链接，或输入 地址 邀请码",
                FormKind::Name => "输入设备名称",
                FormKind::DownloadDirectory => "输入默认保存目录（已存在的目录，支持 ~）",
                FormKind::Path(_) => "输入普通文件完整路径（暂存后需确认发送）",
                FormKind::Connect(_) => "输入已入群设备的 http://IP:端口",
                FormKind::Save { .. } => "输入保存文件的完整目标路径（含文件名；拒绝覆盖）",
                FormKind::Command => "输入命令；/help 查看用法",
            };
            let initial = match &kind {
                FormKind::DownloadDirectory => Some(app.download_directory()?),
                FormKind::Save { name, .. } => Some(app.suggested_save_path(name)?),
                _ => None,
            };
            let mut next_editor = Editor::default();
            if let Some(path) = initial {
                next_editor.insert(
                    path.to_str()
                        .context("保存路径不是 UTF-8，请选择其他目录")?,
                )?;
            }
            ui.open_form(title, kind);
            *editor = next_editor;
        }
        Action::Select(id) => {
            launch(core, ui, job, "select_group", json!({"id":id}))?;
            ui.menu = 0;
            ui.selected = None;
            app.detail = None;
        }
        Action::Browse(path) => ui.browse(path)?,
        Action::Stage(path) => {
            app.stage(
                path.to_str()
                    .context("文件路径不是 UTF-8；请通过支持 UTF-8 的文件名选择")?,
            )?;
            ui.menu = 7;
            ui.selected = Some("send".into());
        }
        Action::Send(draft) => {
            launch(
                core,
                ui,
                job,
                "send_file",
                json!({"groupId":draft.group,"path":draft.path}),
            )?;
            job.as_mut().unwrap().draft = Some(draft.id);
            ui.transfer = "正在发送附件…".into();
        }
        Action::Discard(id) => {
            app.remove_draft(&id)?;
            app.notice = "附件已移除".into();
        }
        Action::Invite(group) => launch(core, ui, job, "create_invite", json!({"groupId":group}))?,
        Action::Requests => {
            app.refresh(core).await?;
            app.notice = "加入申请已刷新".into();
        }
        Action::Respond { group, id, allow } => launch(
            core,
            ui,
            job,
            "respond_join",
            json!({"groupId":group,"id":id,"allow":allow}),
        )?,
        Action::Detail(lines) => {
            app.detail = Some(lines);
            app.scroll = 0;
        }
        Action::History { group, before } => launch(
            core,
            ui,
            job,
            "get_state",
            json!({"groupId":group,"before":before,"limit":100}),
        )?,
        Action::Cancel => {
            let id = job
                .as_ref()
                .and_then(|j| j.transfer.as_deref())
                .context("当前没有可取消的传输")?;
            let value = core
                .dispatch("cancel_transfer", json!({"transferId":id}))
                .await?;
            app.notice = if value["ok"] == true {
                "已请求取消，等待清理"
            } else {
                "传输尚未开始或已完成，请检查结果"
            }
            .into();
        }
        Action::Quit => return Ok(true),
    }
    Ok(false)
}
async fn submit_form(
    core: &Core,
    app: &mut App,
    ui: &mut Workspace,
    editor: &mut Editor,
    job: &mut Option<Job>,
) -> Result<bool> {
    let (_, kind) = ui.form.as_ref().context("没有正在输入的表单")?;
    if matches!(kind, FormKind::Command) {
        let quit = submit(core, app, editor, job).await?;
        ui.form = None;
        ui.focus = Focus::Content;
        return Ok(quit);
    }
    let text = editor.text.trim();
    anyhow::ensure!(!text.is_empty(), "输入不能为空，原内容已保留");
    let (method, params) = match kind {
        FormKind::Text(group) => ("send_text", json!({"groupId":group,"text":editor.text})),
        FormKind::Create => ("create_group", json!({"name":text})),
        FormKind::Join => ("join_group", app::join_params(text)?),
        FormKind::Name => ("rename_device", json!({"name":text})),
        FormKind::Connect(group) => ("connect_peer", json!({"groupId":group,"address":text})),
        FormKind::Save { group, id, .. } => {
            ("save_file", json!({"groupId":group,"id":id,"path":text}))
        }
        FormKind::DownloadDirectory => {
            app.set_download_directory(text)?;
            ui.form = None;
            ui.focus = Focus::Content;
            *editor = Editor::default();
            return Ok(false);
        }
        FormKind::Path(group) => {
            app.stage_for_group(text, group.clone())?;
            ui.form = None;
            ui.focus = Focus::Content;
            ui.menu = 7;
            ui.selected = Some("send".into());
            *editor = Editor::default();
            return Ok(false);
        }
        FormKind::Command => unreachable!(),
    };
    launch(core, ui, job, method, params)?;
    app.notice = "正在处理…".into();
    ui.form = None;
    ui.focus = Focus::Content;
    *editor = Editor::default();
    Ok(false)
}
pub(crate) async fn key_action(
    core: &Core,
    app: &mut App,
    ui: &mut Workspace,
    editor: &mut Editor,
    job: &mut Option<Job>,
    key: KeyCode,
) -> Result<bool> {
    if ui.confirmation.is_some() {
        match key {
            KeyCode::Left | KeyCode::Up => ui.confirm_yes = false,
            KeyCode::Right | KeyCode::Down => ui.confirm_yes = true,
            KeyCode::Esc => {
                ui.confirmation = None;
            }
            KeyCode::Enter => {
                let (_, action) = ui.confirmation.take().unwrap();
                if ui.confirm_yes {
                    return activate(core, app, ui, editor, job, action, true).await;
                }
            }
            _ => {}
        }
        return Ok(false);
    }
    if ui.focus == Focus::Input {
        match key {
            KeyCode::Char(c) => editor.insert(&c.to_string())?,
            KeyCode::Backspace => editor.backspace(),
            KeyCode::Delete => editor.delete(),
            KeyCode::Left => editor.left(),
            KeyCode::Right => editor.right(),
            KeyCode::Home => editor.cursor = 0,
            KeyCode::End => editor.cursor = editor.text.len(),
            KeyCode::Esc => {
                ui.form = None;
                ui.focus = Focus::Content;
                *editor = Editor::default();
            }
            KeyCode::Enter => return submit_form(core, app, ui, editor, job).await,
            _ => {}
        }
        return Ok(false);
    }
    match key {
        KeyCode::Char('/') => {
            ui.open_form("命令输入；Enter 执行 · Esc 返回", FormKind::Command);
            *editor = Editor::default();
            editor.insert("/")?;
        }
        KeyCode::Char('i') if ui.menu == 0 => {
            return activate(
                core,
                app,
                ui,
                editor,
                job,
                Action::Form(FormKind::Text(app.group()?)),
                false,
            )
            .await
        }
        KeyCode::Esc => {
            if app.detail.take().is_none() {
                ui.focus = Focus::Menu;
            }
            app.scroll = 0;
        }
        KeyCode::Tab | KeyCode::BackTab => {
            ui.focus = if ui.focus == Focus::Menu {
                Focus::Content
            } else {
                Focus::Menu
            };
            app.detail = None;
        }
        KeyCode::Left => {
            if app.detail.take().is_none() {
                ui.focus = Focus::Menu;
            }
            app.scroll = 0;
        }
        KeyCode::Right if ui.focus == Focus::Menu => {
            ui.focus = Focus::Content;
        }
        KeyCode::Home | KeyCode::End if ui.focus == Focus::Menu => {
            ui.menu = if key == KeyCode::Home {
                0
            } else {
                MENUS.len() - 1
            };
            ui.selected = None;
            app.detail = None;
        }
        KeyCode::Up | KeyCode::Down | KeyCode::PageUp | KeyCode::PageDown => {
            let delta = match key {
                KeyCode::Up => -1,
                KeyCode::Down => 1,
                KeyCode::PageUp => -5,
                _ => 5,
            };
            if ui.focus == Focus::Menu {
                ui.change_menu(delta);
                if ui.menu == 2 {
                    ui.browse(ui.directory.clone())?;
                }
                app.detail = None;
                app.scroll = 0;
            } else if app.detail.is_some() {
                app.scroll = app.scroll.saturating_add_signed(delta);
            } else {
                ui.move_selection(&ui.rows(app), delta);
            }
        }
        KeyCode::Enter if ui.focus == Focus::Menu => {
            ui.focus = Focus::Content;
        }
        KeyCode::Enter | KeyCode::Right if app.detail.is_none() => {
            let rows = ui.rows(app);
            if let Some(row) = rows.get(ui.index(&rows)) {
                return activate(core, app, ui, editor, job, row.action.clone(), false).await;
            }
        }
        _ => {}
    }
    Ok(false)
}
pub(crate) fn result_lines(method: &str, value: &Value) -> Vec<String> {
    match method {
        "create_invite" => vec![
            format!("邀请码：{}", s(value, "code")),
            format!("邀请链接：{}", s(value, "link")),
            format!("有效期截止（Unix 毫秒）：{}", value["expiresAt"]),
            "复制完整链接给另一设备；通过加入申请菜单审批。".into(),
        ],
        "save_file" => vec![format!("已校验并保存：{}", s(value, "path"))],
        "get_state" => {
            let mut lines = vec![format!("群：{} · 历史消息", s(value, "name"))];
            if let Some(messages) = value["messages"].as_array() {
                for message in messages {
                    lines.push(format!(
                        "{} [{}]",
                        s(message, "senderName"),
                        s(message, "id")
                    ));
                    lines.push(if message["type"] == "file" {
                        format!("[文件] {}", s(message, "fileName"))
                    } else {
                        s(message, "text").into()
                    });
                }
            }
            lines.push(format!(
                "更早游标：{}（命令 /history 游标）",
                s(&value["history"], "before")
            ));
            lines
        }
        "list_join_requests" => value
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|r| format!("{} · {}", s(&r["device"], "name"), s(r, "id")))
                    .collect()
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn approval_requires_explicit_choice_and_uses_captured_request() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let host =
            Core::open_with_bind_address(a.path().into(), "desktop", std::net::Ipv4Addr::LOCALHOST)
                .await
                .unwrap();
        let peer =
            Core::open_with_bind_address(b.path().into(), "desktop", std::net::Ipv4Addr::LOCALHOST)
                .await
                .unwrap();
        let group = host
            .dispatch("create_group", json!({"name":"审批键盘测试"}))
            .await
            .unwrap();
        let invite = host
            .dispatch("create_invite", json!({"groupId":group["id"]}))
            .await
            .unwrap();
        let ticket = peer
            .dispatch(
                "join_group",
                json!({"address":invite["baseUrl"],"code":invite["code"]}),
            )
            .await
            .unwrap();
        let mut app = App::open(a.path()).unwrap();
        app.refresh(&host).await.unwrap();
        let mut ui = Workspace::new().unwrap();
        ui.menu = 5;
        ui.focus = Focus::Content;
        let mut editor = Editor::default();
        let mut job = None;
        for key in [KeyCode::Down, KeyCode::Enter, KeyCode::Enter] {
            key_action(&host, &mut app, &mut ui, &mut editor, &mut job, key)
                .await
                .unwrap();
        }
        assert!(job.is_none());
        assert_eq!(app.requests.as_array().unwrap().len(), 1);
        for key in [KeyCode::Enter, KeyCode::Right, KeyCode::Enter] {
            key_action(&host, &mut app, &mut ui, &mut editor, &mut job, key)
                .await
                .unwrap();
        }
        let response = job.take().unwrap().task.await.unwrap().unwrap();
        assert!(!response.is_null());
        app.refresh(&host).await.unwrap();
        assert!(app.requests.as_array().unwrap().is_empty());
        let joined = peer
            .dispatch("check_join", json!({"ticket":ticket}))
            .await
            .unwrap();
        assert_eq!(joined["status"], "approved");
        peer.shutdown().await;
        host.shutdown().await;
    }
    #[tokio::test]
    async fn keyboard_moves_focus_opens_forms_and_cancel_is_default() {
        let directory = tempfile::tempdir().unwrap();
        let core = Core::open_with_bind_address(
            directory.path().into(),
            "desktop",
            std::net::Ipv4Addr::LOCALHOST,
        )
        .await
        .unwrap();
        let mut app = App::open(directory.path()).unwrap();
        app.refresh(&core).await.unwrap();
        let mut ui = Workspace::new().unwrap();
        let mut editor = Editor::default();
        let mut job = None;
        for key in [KeyCode::Down, KeyCode::Right, KeyCode::Enter] {
            key_action(&core, &mut app, &mut ui, &mut editor, &mut job, key)
                .await
                .unwrap();
        }
        assert!(matches!(ui.form, Some((_, FormKind::Create))));
        editor.insert("新的群").unwrap();
        key_action(
            &core,
            &mut app,
            &mut ui,
            &mut editor,
            &mut job,
            KeyCode::Esc,
        )
        .await
        .unwrap();
        assert_eq!(ui.focus, Focus::Content);
        assert!(ui.form.is_none());
        assert!(app.groups().is_empty());
        activate(
            &core,
            &mut app,
            &mut ui,
            &mut editor,
            &mut job,
            Action::Quit,
            false,
        )
        .await
        .unwrap();
        assert!(!ui.confirm_yes);
        assert!(!key_action(
            &core,
            &mut app,
            &mut ui,
            &mut editor,
            &mut job,
            KeyCode::Enter
        )
        .await
        .unwrap());
        assert!(ui.confirmation.is_none());
        core.shutdown().await;
    }
}
