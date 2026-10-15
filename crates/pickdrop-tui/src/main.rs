mod app;
mod interaction;
mod terminal;
mod view;
mod workspace;

use anyhow::{bail, Context, Result};
use pickdrop_core::Core;
use serde_json::{json, Value};
use std::{fs::File, io::IsTerminal, net::Ipv4Addr, path::PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const HELP: &str = "拾传 Rust TUI\n\npickdrop [--data-dir PATH] [--bind IPv4] [--json]\n\n默认只监听 127.0.0.1；可信局域网使用 --bind 0.0.0.0。\n无 Node、桌面环境或后台服务依赖。退出时停止本进程。\n--json 使用标准输入/输出 JSON Lines，供脚本和验收使用。\n进入界面后 /help 查看命令。";

struct Options {
    data: PathBuf,
    bind: Ipv4Addr,
    json: bool,
}
fn options(args: impl Iterator<Item = String>) -> Result<Option<Options>> {
    let mut args = args.peekable();
    let mut data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .map(|base| base.join("pickdrop-tui"));
    let mut bind = Ipv4Addr::LOCALHOST;
    let mut json = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(None);
            }
            "--version" | "-V" => {
                println!("pickdrop {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--data-dir" => data = Some(PathBuf::from(args.next().context("--data-dir 缺少路径")?)),
            "--bind" => {
                bind = args
                    .next()
                    .context("--bind 缺少 IPv4 地址")?
                    .parse()
                    .context("--bind 必须是 IPv4 地址")?
            }
            "--json" => json = true,
            _ => bail!("未知参数 {arg}；使用 --help 查看用法"),
        }
    }
    Ok(Some(Options {
        data: data.context("无法确定数据目录，请指定 --data-dir")?,
        bind,
        json,
    }))
}
fn lock_data(data: &std::path::Path) -> Result<File> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(data)?;
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("tui.lock"))?;
    file.try_lock()
        .context("此数据目录已有拾传进程，请退出原进程或指定另一个 --data-dir")?;
    Ok(file)
}
async fn json_lines(core: &Core) -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    loop {
        let line = tokio::select! {
            line = lines.next_line() => line?,
            _ = tokio::signal::ctrl_c() => break,
        };
        let Some(line) = line else { break };
        let request = serde_json::from_str::<Value>(&line);
        let (id, result) = match request {
            Ok(request) => {
                let method = request["method"].as_str().unwrap_or("");
                (
                    request["id"].clone(),
                    app::dispatch(core, method, request["params"].clone()).await,
                )
            }
            Err(error) => (Value::Null, Err(error.into())),
        };
        let response = match result {
            Ok(value) => json!({"id":id,"ok":true,"value":value}),
            Err(error) => json!({"id":id,"ok":false,"error":format!("{error:#}")}),
        };
        output.write_all(format!("{response}\n").as_bytes()).await?;
        output.flush().await?;
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    let Some(options) = options(std::env::args().skip(1))? else {
        return Ok(());
    };
    if !options.json && (!std::io::stdin().is_terminal() || !std::io::stdout().is_terminal()) {
        bail!("交互界面需要终端；SSH 请使用 -t，脚本请使用 --json");
    }
    let _lock = lock_data(&options.data)?;
    let core = Core::open_with_bind_address(options.data.clone(), "desktop", options.bind).await?;
    let session = async {
        if options.json {
            json_lines(&core).await
        } else {
            terminal::run(&core, &options.data).await
        }
    };
    #[cfg(unix)]
    let result = {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = session => result,
            _ = terminate.recv() => Ok(()),
            _ = tokio::signal::ctrl_c() => Ok(()),
        }
    };
    #[cfg(not(unix))]
    let result = session.await;
    core.shutdown().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn options_reject_invalid_binding_and_missing_values() {
        for args in [
            vec!["--bind", "invalid"],
            vec!["--data-dir"],
            vec!["--unknown"],
        ] {
            assert!(options(args.into_iter().map(String::from)).is_err());
        }
        assert_eq!(
            options(["--json".into()].into_iter())
                .unwrap()
                .unwrap()
                .bind,
            Ipv4Addr::LOCALHOST
        );
    }
    #[test]
    fn exclusive_directory_lock_is_released_on_exit() {
        let directory = tempfile::tempdir().unwrap();
        let first = lock_data(directory.path()).unwrap();
        assert!(lock_data(directory.path()).is_err());
        drop(first);
        assert!(lock_data(directory.path()).is_ok());
    }
}
