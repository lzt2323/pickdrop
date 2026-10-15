# JavaScript 协议兼容向量

这里的 JSON 来自旧 JavaScript 实现，用于验证 Rust 核心继续兼容 `pickdrop-peer-v1`。旧 Node 服务和客户端已退役，这些固定测试向量仍是当前 Rust 测试的输入，不依赖旧客户端运行。

- `peer-v1.json`：已签名的群组创建、事件、设备证明、加入证明、canonical JSON 与预期状态；还用于发现、连接、取消、撤销和旧数据导入测试。
- `peer-v1-cases.json`：并发事件、成员权限及应拒绝的事件样例，验证状态投影和失败后的回滚。

`crates/pickdrop-core/tests/` 通过 `include_str!` 直接读取这些文件。不要删除或用当前 Rust 实现重新生成并覆盖它们，否则会失去独立的旧协议兼容基线。向量中的固定身份和测试密钥仅用于测试。

验证命令：`cargo test -p pickdrop-core --locked`。
