# 独立 Rust 编码实验

仅验证协议实验的 JSON／UTF-8／JCS 编码、固定封装及已有学习记录平局规则；不被应用导入，不修改正式 Schema，不解释生产业务操作或验证完整记录 DAG。

在仓库根目录构建和测试：

```powershell
cargo build --offline --manifest-path tools/record-sync-protocol-lab/rust/Cargo.toml
cargo check --offline --manifest-path tools/record-sync-protocol-lab/rust/Cargo.toml
cargo test --offline --manifest-path tools/record-sync-protocol-lab/rust/Cargo.toml
```

首次构建须先通过 `cargo fetch --manifest-path tools/record-sync-protocol-lab/rust/Cargo.toml` 准备锁定依赖。应用 Cargo 项目及依赖保持独立。

运行 `tools/record-sync-protocol-lab/rust/target/debug/record-sync-codec-lab.exe`，stdin 每行一个请求，stdout 每行一个 UTF-8 JSON 回复；错误回复 `ok:false` 后继续读取。支持 `canonicalize`、`decode`、`number`、`join`、`record` 和 `business`，接口由上级实验统一语料驱动。

解析器在构造映射之前检查重复键，拒绝非法 UTF-8、孤立代理项、非字符、超深／超大 JSON。数值使用 `ryu-js` 独立实现 ECMAScript binary64 输出，字符串及对象键按 UTF-16 语义处理；运行时不调用 Node，不读取共享语料的期望结果。

`business` 保留现有复盘整篇墙钟、删除平局与 `canonicalLearning` 排序，以及评分方案同刻清除优先；它不是将字段因果 ADR 引入应用的实现。
