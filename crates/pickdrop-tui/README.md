# 拾传 Rust TUI

轻量终端客户端，直接复用 `pickdrop-core`，运行时不需要 Node、Tauri 或图形桌面。终端输入使用 crossterm；没有另建同步服务、后台守护进程或 RPC 端口。旧 Node TUI 仅从 Git 历史参考命令和发送确认流程，当前源码不包含它。

```sh
cargo build --release -p pickdrop-tui --locked
./target/release/pickdrop --data-dir /path/to/data
```

默认监听 `127.0.0.1`，适用于 SSH 和同机测试。在可信局域网中使用 `--bind 0.0.0.0` 或绑定指定网卡 IPv4 地址。协议目前没有 TLS，不应将监听端口开放到公网。SSH 中输入的文件路径属于服务器；数据目录与测试文件目录是不同概念。

交互模式需要 TTY（SSH 使用 `ssh -t`）。首次启动可输入 `/create 传输群`。文字直接回车发送；文件先 `/file /path/有 空格.txt`，检查当前群与待发路径，再 `/send` 确认。每群最多暂存一个文件，草稿随数据目录保存，`/discard` 移除。切换群不会改变附件目标。退出停止同步服务，保留身份、群组、消息和附件草稿。

- `/groups`、`/use 序号或ID前缀`、Tab：切换群。
- `/invite`：显示邀请码及完整链接；`/join 完整链接` 或 `/join 地址 邀请码`：申请加入。批准后核心自动完成入群，关闭界面也不会丢失申请。
- `/requests`、`/approve 申请ID`、`/deny 申请ID`：审批。
- `/devices`、`/connect 地址`：设备状态及显式连接已入群设备。
- `/save 消息ID 目标路径`：按需接收并保存文件，拒绝覆盖已有路径。
- `/cancel`：取消当前文件传输；失败或取消保留发送草稿。
- `/history 游标`：查询更早的 100 条消息，游标见返回的 `history.before`。
- `/name 设备名`、`/help`、`/quit`；↑/↓、PageUp/PageDown 滚动，Esc 返回聊天。

不提供旧版 Node 守护进程、systemd 管理、目录批量发送、二维码、自动接收全部文件或断点续传。需要在 SSH 断开后持续运行时，可由用户在 tmux 中启动；本工具不自动创建后台服务。旧数据不自动导入，需新建身份重新加入群，旧源码继续由 Git 历史追溯。

## 脚本与验收

`--json` 提供仅通过标准输入/输出的 JSON Lines 模式，每行调用共享核心一次，返回 `{id,ok,value}` 或 `{id,ok,error}`；没有新增网络管理 API。`save_file` 是终端适配命令，参数为 `groupId`、消息 `id` 和目标 `path`，其余方法沿用核心接口。运行期间同一数据目录只允许一个进程，EOF 正常退出。

```sh
printf '%s\n' '{"id":1,"method":"bootstrap","params":{}}' | ./target/release/pickdrop --json --data-dir /tmp/pickdrop-test
cargo test -p pickdrop-tui -p pickdrop-core --locked
python3 scripts/test-rust-tui.py target/release/pickdrop --output .build/reports/rust-tui
```

验收脚本使用独立数据和生成的文件，覆盖两个真实节点的审批、双向消息与文件哈希、已有目标拒绝覆盖、重启身份/历史、非法输入及终端模式恢复。它不读取已有业务文件，也不自动发送到用户的真实群。
