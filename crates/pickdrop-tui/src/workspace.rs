//! Keyboard workspace state and human-readable views; actions capture stable IDs.
use crate::app::{App, Draft};
use anyhow::{Context, Result};
use pickdrop_core::protocol::s;
use std::path::PathBuf;

pub const MENUS: &[&str] = &[
    "群聊消息",
    "切换 / 新建群",
    "发送文件",
    "群内文件",
    "邀请 / 加入",
    "加入申请",
    "设备 / 连接",
    "传输 / 草稿",
    "设备设置",
    "帮助",
    "退出",
];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    Menu,
    Content,
    Input,
}
#[derive(Clone, Debug)]
pub enum FormKind {
    Text(String),
    Create,
    Join,
    Name,
    Path(String),
    Connect(String),
    Save { group: String, id: String },
    Command,
}
#[derive(Clone)]
pub enum Action {
    None,
    Form(FormKind),
    Select(String),
    Browse(PathBuf),
    Stage(PathBuf),
    Send(Draft),
    Discard(String),
    Invite(String),
    Requests,
    Respond {
        group: String,
        id: String,
        allow: bool,
    },
    Detail(Vec<String>),
    History {
        group: String,
        before: String,
    },
    Cancel,
    Quit,
}
#[derive(Clone)]
pub struct Row {
    pub key: String,
    pub label: String,
    pub action: Action,
}
impl Row {
    fn new(key: impl Into<String>, label: impl Into<String>, action: Action) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            action,
        }
    }
}
pub struct Workspace {
    pub menu: usize,
    pub focus: Focus,
    pub selected: Option<String>,
    pub form: Option<(String, FormKind)>,
    pub confirmation: Option<(String, Action)>,
    pub confirm_yes: bool,
    pub directory: PathBuf,
    pub files: Vec<Row>,
    pub transfer: String,
}
impl Workspace {
    pub fn new() -> Result<Self> {
        let mut workspace = Self {
            menu: 0,
            focus: Focus::Menu,
            selected: None,
            form: None,
            confirmation: None,
            confirm_yes: false,
            directory: std::env::current_dir()?,
            files: vec![],
            transfer: "本次会话暂无传输".into(),
        };
        workspace.browse(workspace.directory.clone())?;
        Ok(workspace)
    }
    pub fn browse(&mut self, path: PathBuf) -> Result<()> {
        let path = path.canonicalize().context("无法打开目录")?;
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&path).context("无法读取目录")? {
            let entry = entry.context("读取目录项失败")?;
            let metadata = entry.metadata().context("无法读取文件属性")?;
            if !metadata.is_dir() && !metadata.is_file() {
                continue;
            }
            let target = entry.path();
            let action = if metadata.is_dir() {
                Action::Browse(target.clone())
            } else {
                Action::Stage(target.clone())
            };
            files.push((
                metadata.is_dir(),
                Row::new(
                    target.to_string_lossy(),
                    format!(
                        "{} {}{}",
                        if metadata.is_dir() {
                            "[目录]"
                        } else {
                            "[文件]"
                        },
                        entry.file_name().to_string_lossy(),
                        if metadata.is_dir() {
                            String::new()
                        } else {
                            format!("  {} 字节", metadata.len())
                        }
                    ),
                    action,
                ),
            ));
        }
        files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.label.cmp(&b.1.label)));
        self.files = files.into_iter().map(|(_, row)| row).collect();
        if let Some(parent) = path.parent() {
            self.files.insert(
                0,
                Row::new("parent", "[..] 上级目录", Action::Browse(parent.into())),
            );
        }
        self.directory = path;
        self.selected = None;
        Ok(())
    }
    pub fn accepts_result(&self, menu: Option<usize>) -> bool {
        self.focus == Focus::Content
            && self.form.is_none()
            && self.confirmation.is_none()
            && menu.is_none_or(|origin| origin == self.menu)
    }
    pub fn select_latest_message(&mut self, app: &App) {
        if self.menu == 0 && self.selected.is_none() {
            self.selected = app.state["messages"]
                .as_array()
                .and_then(|messages| messages.last())
                .and_then(|message| message["id"].as_str())
                .map(str::to_owned);
        }
    }
    pub fn change_menu(&mut self, delta: isize) {
        self.menu = self.menu.saturating_add_signed(delta).min(MENUS.len() - 1);
        self.selected = None;
    }
    pub fn index(&self, rows: &[Row]) -> usize {
        self.selected
            .as_ref()
            .and_then(|key| rows.iter().position(|row| &row.key == key))
            .unwrap_or(0)
    }
    pub fn move_selection(&mut self, rows: &[Row], delta: isize) {
        if rows.is_empty() {
            self.selected = None;
            return;
        }
        let index = self
            .index(rows)
            .saturating_add_signed(delta)
            .min(rows.len() - 1);
        self.selected = Some(rows[index].key.clone());
    }
    pub fn open_form(&mut self, title: &str, kind: FormKind) {
        self.form = Some((title.into(), kind));
        self.focus = Focus::Input;
    }
    pub fn rows(&self, app: &App) -> Vec<Row> {
        let group = app.group().unwrap_or_default();
        let mut rows = Vec::new();
        match self.menu {
            0 => {
                rows.push(Row::new(
                    "compose",
                    "[发送文字] Enter 开始输入",
                    Action::Form(FormKind::Text(group.clone())),
                ));
                if app.state["history"]["hasMore"] == true {
                    rows.push(Row::new(
                        "history",
                        "[加载更早消息]",
                        Action::History {
                            group: group.clone(),
                            before: s(&app.state["history"], "before").into(),
                        },
                    ));
                }
                if let Some(messages) = app.state["messages"].as_array() {
                    for message in messages {
                        let text = if message["type"] == "file" {
                            format!(
                                "[文件] {}  {} 字节",
                                s(message, "fileName"),
                                message["size"]
                            )
                        } else {
                            s(message, "text").into()
                        };
                        let action = if message["type"] == "file" {
                            Action::Form(FormKind::Save {
                                group: group.clone(),
                                id: s(message, "id").into(),
                            })
                        } else {
                            Action::Detail(vec![
                                format!("发送者：{}", s(message, "senderName")),
                                format!("消息 ID：{}", s(message, "id")),
                                text.clone(),
                            ])
                        };
                        rows.push(Row::new(
                            s(message, "id"),
                            format!("{} · {}", s(message, "senderName"), text),
                            action,
                        ));
                    }
                }
            }
            1 => {
                rows.push(Row::new(
                    "create",
                    "[新建传输群]",
                    Action::Form(FormKind::Create),
                ));
                rows.push(Row::new(
                    "join",
                    "[通过邀请加入]",
                    Action::Form(FormKind::Join),
                ));
                for item in app.groups() {
                    rows.push(Row::new(
                        s(item, "id"),
                        format!(
                            "{} {}",
                            if item["id"] == app.boot["activeGroupId"] {
                                "●"
                            } else {
                                "○"
                            },
                            s(item, "name")
                        ),
                        Action::Select(s(item, "id").into()),
                    ));
                }
            }
            2 => {
                rows.push(Row::new(
                    "path",
                    "[输入文件路径]（支持空格和 ~）",
                    Action::Form(FormKind::Path(group.clone())),
                ));
                if let Ok(draft) = app.current_draft() {
                    rows.push(Row::new("send", "[确认发送当前附件]", Action::Send(draft)));
                }
                rows.extend(self.files.clone());
            }
            3 => {
                if let Some(messages) = app.state["messages"].as_array() {
                    for message in messages.iter().filter(|m| m["type"] == "file") {
                        rows.push(Row::new(
                            s(message, "id"),
                            format!(
                                "{} · {} 字节 · {}",
                                s(message, "fileName"),
                                message["size"],
                                s(message, "senderName")
                            ),
                            Action::Form(FormKind::Save {
                                group: group.clone(),
                                id: s(message, "id").into(),
                            }),
                        ));
                    }
                }
            }
            4 => {
                rows.push(Row::new(
                    "invite",
                    "[生成当前群邀请]",
                    Action::Invite(group),
                ));
                rows.push(Row::new(
                    "join",
                    "[粘贴邀请链接加入群]",
                    Action::Form(FormKind::Join),
                ));
            }
            5 => {
                rows.push(Row::new("refresh", "[刷新加入申请]", Action::Requests));
                if let Some(requests) = app.requests.as_array() {
                    for request in requests {
                        // Both choices retain the request and group IDs even if a refresh reorders the list.
                        for allow in [true, false] {
                            rows.push(Row::new(
                                format!("{}:{allow}", s(request, "id")),
                                format!(
                                    "[{}] {} · {}",
                                    if allow {
                                        "允许加入"
                                    } else {
                                        "拒绝加入"
                                    },
                                    s(&request["device"], "name"),
                                    s(request, "id")
                                ),
                                Action::Respond {
                                    group: group.clone(),
                                    id: s(request, "id").into(),
                                    allow,
                                },
                            ));
                        }
                    }
                }
            }
            6 => {
                rows.push(Row::new(
                    "connect",
                    "[连接同群设备地址]",
                    Action::Form(FormKind::Connect(group)),
                ));
                if let Some(devices) = app.state["devices"].as_array() {
                    for device in devices {
                        rows.push(Row::new(
                            s(device, "id"),
                            format!(
                                "{} {} · {}",
                                if device["online"] == true {
                                    "● 在线"
                                } else {
                                    "○ 离线"
                                },
                                s(device, "name"),
                                s(device, "id")
                            ),
                            Action::Detail(vec![
                                format!("设备：{}", s(device, "name")),
                                format!("ID：{}", s(device, "id")),
                            ]),
                        ));
                    }
                }
            }
            7 => {
                rows.push(Row::new("cancel", "[取消当前传输]", Action::Cancel));
                if let Ok(draft) = app.current_draft() {
                    rows.push(Row::new(
                        "send",
                        format!("[发送 / 重试] {}", draft.path.display()),
                        Action::Send(draft.clone()),
                    ));
                    rows.push(Row::new(
                        "discard",
                        "[移除当前群附件草稿]",
                        Action::Discard(draft.id),
                    ));
                }
            }
            8 => {
                rows.push(Row::new(
                    "name",
                    "[修改设备名称]",
                    Action::Form(FormKind::Name),
                ));
            }
            9 => {
                for (index, line) in crate::app::HELP.iter().enumerate() {
                    rows.push(Row::new(index.to_string(), *line, Action::None));
                }
            }
            10 => rows.push(Row::new(
                "quit",
                "[退出拾传] 停止本次服务，保留身份和草稿",
                Action::Quit,
            )),
            _ => {}
        }
        rows
    }
    pub fn context(&self, app: &App) -> Vec<String> {
        match self.menu {
            0 => vec!["↑↓ 选择消息 · Enter 查看文字 / 保存文件".into()],
            2 => vec![
                format!("目录：{}", self.directory.display()),
                "Enter 打开目录或暂存文件；暂存不会发送".into(),
            ],
            3 => vec!["Enter 输入完整保存路径；已有文件不会被覆盖".into()],
            5 => vec!["选中允许或拒绝后 Enter，再确认；申请列表自动刷新".into()],
            7 => vec![self.transfer.clone()],
            8 => vec![
                format!("设备名称：{}", s(&app.boot["device"], "name")),
                format!("监听地址：{}", s(&app.boot["endpoint"], "baseUrl")),
                "文件路径属于当前运行主机；退出不启动后台服务".into(),
            ],
            _ => vec![],
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_is_bounded_and_selection_uses_stable_ids() {
        let mut ui = Workspace::new().unwrap();
        ui.change_menu(-1);
        assert_eq!(ui.menu, 0);
        ui.change_menu(100);
        assert_eq!(ui.menu, MENUS.len() - 1);
        let a = Row::new("a", "A", Action::None);
        let b = Row::new("b", "B", Action::None);
        ui.move_selection(&[a.clone(), b.clone()], 1);
        assert_eq!(ui.index(&[b, a]), 0);
        ui.move_selection(&[], 1);
        assert!(ui.selected.is_none());
    }
    #[test]
    fn late_results_cannot_hide_input_or_replace_confirmation() {
        let mut ui = Workspace::new().unwrap();
        assert!(!ui.accepts_result(Some(0)));
        ui.focus = Focus::Content;
        assert!(ui.accepts_result(Some(0)));
        assert!(!ui.accepts_result(Some(1)));
        ui.open_form("输入名称", FormKind::Create);
        assert!(!ui.accepts_result(None));
        ui.focus = Focus::Content;
        assert!(!ui.accepts_result(None));
        ui.form = None;
        ui.confirmation = Some(("退出？".into(), Action::Quit));
        assert!(!ui.accepts_result(None));
    }
    #[test]
    fn failed_browse_preserves_directory_and_file_actions_do_not_send() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("中文 文件.txt"), b"x").unwrap();
        let mut ui = Workspace::new().unwrap();
        ui.browse(directory.path().into()).unwrap();
        assert!(ui
            .files
            .iter()
            .any(|r| matches!(r.action, Action::Stage(_))));
        let previous = ui.directory.clone();
        assert!(ui.browse(directory.path().join("missing")).is_err());
        assert_eq!(ui.directory, previous);
    }
}
