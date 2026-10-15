//! Terminal commands adapt the shared core; pairing and transfers stay in core.
use anyhow::{bail, ensure, Context, Result};
use pickdrop_core::{
    protocol::{random, s},
    Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const HELP: &[&str] = &[
    "↑↓ 选择 · ←→ / Tab 切换面板 · Enter 确认 · Esc 返回",
    "群聊中按 i 输入文字；/ 打开命令输入；输入时 Enter 提交、Esc 取消",
    "宽屏左右两列，窄屏单栏；PageUp / PageDown 翻页；Ctrl+C 退出",
    "/create 群名 | /groups | /use 序号或群ID | /name 设备名",
    "/invite | /join 邀请链接 或 /join 地址 邀请码",
    "/requests | /approve 申请ID | /deny 申请ID | /devices",
    "/file 路径：暂存文件（每群一个，支持空格、~）",
    "/send：确认发送当前群附件 | /discard：移除当前群附件",
    "/save 消息ID 目标路径：接收文件，拒绝覆盖已有文件",
    "/connect 地址 | /history 游标 | /cancel：取消当前传输",
    "/quit 或 Ctrl+C 退出；退出停止网络服务，附件草稿保留",
];
#[derive(Clone, Serialize, Deserialize)]
pub struct Draft {
    pub id: String,
    pub group: String,
    pub path: PathBuf,
}
pub struct App {
    pub boot: Value,
    pub state: Value,
    pub requests: Value,
    pub drafts: Vec<Draft>,
    pub notice: String,
    pub detail: Option<Vec<String>>,
    pub scroll: usize,
    draft_file: PathBuf,
}
impl App {
    pub fn open(data: &Path) -> Result<Self> {
        let draft_file = data.join("tui-drafts.json");
        let drafts = match std::fs::read(&draft_file) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).context("附件草稿损坏，请检查 tui-drafts.json")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            boot: Value::Null,
            state: Value::Null,
            requests: Value::Null,
            drafts,
            draft_file,
            notice: "↑↓ 选择菜单，→ / Enter 进入；文件暂存后需确认发送。".into(),
            detail: None,
            scroll: 0,
        })
    }
    pub fn group(&self) -> Result<String> {
        self.boot["activeGroupId"]
            .as_str()
            .map(str::to_owned)
            .context("请先 /create 或 /join 一个群")
    }
    pub fn groups(&self) -> &[Value] {
        self.boot["groups"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub async fn refresh(&mut self, core: &Core) -> Result<bool> {
        let boot = core.dispatch("bootstrap", json!({})).await?;
        let state = match boot["activeGroupId"].as_str() {
            Some(id) => {
                core.dispatch("get_state", json!({"groupId":id,"limit":100}))
                    .await?
            }
            None => Value::Null,
        };
        let requests = match boot["activeGroupId"].as_str() {
            Some(id) => {
                core.dispatch("list_join_requests", json!({"groupId":id}))
                    .await?
            }
            None => Value::Null,
        };
        let changed = boot != self.boot || state != self.state || requests != self.requests;
        self.requests = requests;
        self.boot = boot;
        self.state = state;
        Ok(changed)
    }
    fn persist(&self) -> Result<()> {
        let temporary = self.draft_file.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(&self.drafts)?)?;
        std::fs::rename(temporary, &self.draft_file)?;
        Ok(())
    }
    pub fn stage(&mut self, path: &str) -> Result<()> {
        let group = self.group()?;
        self.stage_for_group(path, group)
    }
    pub fn stage_for_group(&mut self, path: &str, group: String) -> Result<()> {
        ensure!(!group.is_empty(), "请先新建或加入群");
        ensure!(
            !self.drafts.iter().any(|draft| draft.group == group),
            "当前群已有附件，请先 /send 或 /discard"
        );
        let path = expand_path(path)?
            .canonicalize()
            .context("无法读取文件路径")?;
        ensure!(path.is_file(), "请选择普通文件，暂不支持目录");
        self.drafts.push(Draft {
            id: random(12),
            group,
            path,
        });
        if let Err(error) = self.persist() {
            self.drafts.pop();
            return Err(error);
        }
        self.notice = "附件已暂存；使用 /send 确认发送".into();
        Ok(())
    }
    pub fn remove_draft(&mut self, id: &str) -> Result<()> {
        let previous = self.drafts.clone();
        self.drafts.retain(|draft| draft.id != id);
        if let Err(error) = self.persist() {
            self.drafts = previous;
            return Err(error);
        }
        Ok(())
    }
    pub fn current_draft(&self) -> Result<Draft> {
        let group = self.group()?;
        self.drafts
            .iter()
            .find(|draft| draft.group == group)
            .cloned()
            .context("当前群没有待发附件")
    }
    pub fn resolve_group(&self, value: &str) -> Result<String> {
        if let Ok(index) = value.parse::<usize>() {
            return self
                .groups()
                .get(index.wrapping_sub(1))
                .map(|g| s(g, "id").into())
                .context("群序号不存在");
        }
        let matches: Vec<_> = self
            .groups()
            .iter()
            .filter(|g| s(g, "id").starts_with(value))
            .collect();
        ensure!(
            !value.is_empty() && matches.len() == 1,
            "群 ID 不存在或前缀不唯一"
        );
        Ok(s(matches[0], "id").into())
    }
}
pub fn expand_path(value: &str) -> Result<PathBuf> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        .unwrap_or(value);
    ensure!(!value.is_empty(), "路径不能为空");
    if value == "~" || value.starts_with("~/") {
        let home = std::env::var_os("HOME").context("HOME 不可用，请输入绝对路径")?;
        return Ok(PathBuf::from(home).join(value.strip_prefix("~/").unwrap_or("")));
    }
    Ok(PathBuf::from(value))
}
pub fn join_params(value: &str) -> Result<Value> {
    let parts: Vec<_> = value.split_whitespace().collect();
    if parts.len() == 2 {
        return Ok(json!({"address":parts[0],"code":parts[1]}));
    }
    ensure!(
        parts.len() == 1,
        "用法：/join 邀请链接 或 /join 地址 邀请码"
    );
    let url = reqwest::Url::parse(parts[0]).context("邀请链接无效")?;
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let fragment: std::collections::HashMap<_, _> =
        reqwest::Url::parse(&format!("http://local/?{}", url.fragment().unwrap_or("")))?
            .query_pairs()
            .into_owned()
            .collect();
    let address = query
        .get("address")
        .or_else(|| query.get("endpoint"))
        .cloned()
        .or_else(|| {
            matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
        })
        .context("邀请链接缺少地址")?;
    let code = query
        .get("code")
        .or_else(|| fragment.get("invite"))
        .context("邀请链接缺少邀请码")?;
    ensure!(
        !address.is_empty() && !code.is_empty(),
        "邀请地址或邀请码为空"
    );
    Ok(json!({"address":address,"code":code}))
}
pub async fn dispatch(core: &Core, method: &str, params: Value) -> Result<Value> {
    if method != "save_file" {
        return core.dispatch(method, params).await;
    }
    let path = expand_path(params["path"].as_str().context("缺少目标路径")?)?;
    ensure!(!path.exists(), "目标已存在，不会覆盖：{}", path.display());
    let received = core.dispatch("receive_file", params.clone()).await?;
    let source = received["path"]
        .as_str()
        .context("接收结果缺少已校验文件路径")?;
    let source = PathBuf::from(source);
    let destination = path.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut input = std::fs::File::open(source)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        if let Err(error) = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()) {
            drop(output);
            let _ = std::fs::remove_file(destination);
            return Err(error.into());
        }
        Ok(())
    })
    .await??;
    Ok(json!({"path":path,"size":received["size"]}))
}
pub fn command(app: &App, input: &str) -> Result<(String, Value)> {
    let (name, value) = input.split_once(' ').unwrap_or((input, ""));
    let value = value.trim();
    let group = || app.group();
    Ok(match name {
        "/create" => {
            ensure!(!value.is_empty(), "缺少群名");
            ("create_group".into(), json!({"name":value}))
        }
        "/name" => {
            ensure!(!value.is_empty(), "缺少设备名");
            ("rename_device".into(), json!({"name":value}))
        }
        "/join" => ("join_group".into(), join_params(value)?),
        "/use" => (
            "select_group".into(),
            json!({"id":app.resolve_group(value)?}),
        ),
        "/invite" => ("create_invite".into(), json!({"groupId":group()?})),
        "/requests" => ("list_join_requests".into(), json!({"groupId":group()?})),
        "/devices" => ("get_state".into(), json!({"groupId":group()?})),
        "/approve" | "/deny" => {
            ensure!(!value.is_empty(), "缺少申请 ID");
            (
                "respond_join".into(),
                json!({"groupId":group()?,"id":value,"allow":name=="/approve"}),
            )
        }
        "/connect" => {
            ensure!(!value.is_empty(), "缺少设备地址");
            (
                "connect_peer".into(),
                json!({"groupId":group()?,"address":value}),
            )
        }
        "/history" => (
            "get_state".into(),
            json!({"groupId":group()?,"before":value,"limit":100}),
        ),
        "/save" => {
            let (id, path) = value
                .split_once(' ')
                .context("用法：/save 消息ID 目标路径")?;
            (
                "save_file".into(),
                json!({"groupId":group()?,"id":id,"path":path}),
            )
        }
        other if other.starts_with('/') => bail!("未知命令 {other}，使用 /help 查看用法"),
        _ => {
            ensure!(!input.trim().is_empty(), "消息不能为空");
            ("send_text".into(), json!({"groupId":group()?,"text":input}))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drafts_survive_restart_and_remain_bound_to_their_group() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("有 空格.txt");
        std::fs::write(&file, b"content").unwrap();
        let mut app = App::open(directory.path()).unwrap();
        app.boot = json!({"activeGroupId":"A"});
        app.stage(file.to_str().unwrap()).unwrap();
        assert!(app.stage(file.to_str().unwrap()).is_err());
        let mut restored = App::open(directory.path()).unwrap();
        restored.boot = json!({"activeGroupId":"B"});
        assert!(restored.current_draft().is_err());
        restored.boot["activeGroupId"] = json!("A");
        assert_eq!(
            restored.current_draft().unwrap().path,
            file.canonicalize().unwrap()
        );
    }
    #[test]
    fn invitation_and_group_selection_are_unambiguous() {
        assert_eq!(
            join_params("pickdrop://join?address=http%3A%2F%2F127.0.0.1%3A4567&code=123456")
                .unwrap()["address"],
            "http://127.0.0.1:4567"
        );
        assert!(join_params("https://example.com").is_err());
        assert_eq!(
            join_params("http://127.0.0.1:4567/#invite=654321&protocol=peer").unwrap()["code"],
            "654321"
        );
        let mut app = App::open(tempfile::tempdir().unwrap().path()).unwrap();
        app.boot = json!({"groups":[{"id":"abcdef"},{"id":"abcxyz"}]});
        assert!(app.resolve_group("abc").is_err());
        assert!(app.resolve_group("0").is_err());
        assert_eq!(app.resolve_group("2").unwrap(), "abcxyz");
    }
}
