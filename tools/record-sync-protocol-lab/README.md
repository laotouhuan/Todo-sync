# 独立记录协议实验工具

**实验代码，不接应用、不迁移真实数据。** 本目录验证[协议草案](../../docs/record-sync-protocol-design.md)新增的编码、内容寻址、精确补父和初始化边界。它与旧 [record-sync-prototype](../record-sync-prototype/README.md) 并列保留，不能把旧坚果云报告当作本目录已通过真实验收。

`PERSONAL_CHECKIN_PROFILE`（`lab-personal-checkin/1`）继承个人学习操作，扩展固定基线中周／月任务的明确补卡与销卡。[规则与验证](../../docs/record-sync-checkin-explicit-clear-decision.md)。

`PERSONAL_PERIOD_PROFILE`（`lab-personal-period/1`）另支持周／月任务的创建、同周期编辑和软删除。[验证与限制](../../docs/record-sync-period-records-results.md)。

`PERSONAL_SERIES_PROFILE`（`lab-personal-series/1`）继承周期任务操作，验证固定基线中已有系列的改名、解除和重新关联。专项运行 `node --test tools/record-sync-protocol-lab/tests/test-series-records.mjs`。

`PERSONAL_SERIES_WORKFLOW_PROFILE`（`lab-personal-series-workflows/1`）验证跨周期导入和整体删除的原子提交与因果范围。专项运行 `node --test tools/record-sync-protocol-lab/tests/test-series-workflows.mjs`。[工作流验收](../../docs/record-sync-series-workflows-results.md)

`PERSONAL_SERIES_WORKFLOW_V2_PROFILE`（`lab-personal-series-workflows/2`）增加明确手动结束计时操作，保留同一计时的手动结束结果并排除并发自动结束候选。

```powershell
node --test tools/record-sync-protocol-lab/tests/test-period-records.mjs tools/record-sync-protocol-lab/tests/test-checkin-records.mjs tools/record-sync-protocol-lab/tests/test-profile-schema-references.mjs
```

11 月 7 日继续：`PERSONAL_CORE_PROFILE` (`lab-personal-core/1`) 增加整份提醒设置提交，`PERSONAL_LEARNING_PROFILE` (`lab-personal-learning/1`) 再增加计时和复盘整条操作；旧集合及线格式不改，新集合须按固定描述符显式选择。[结果](../../docs/record-sync-reminder-learning-results.md)记录双端提醒门禁、414 项工具回归及原生未接入边界。

```powershell
node tools/record-sync-protocol-lab/run-personal-records.mjs 新报告路径.json
node --test tools/record-sync-protocol-lab/tests/test-personal-records.mjs tools/record-sync-protocol-lab/tests/test-learning-records.mjs
```

2026-11-07 后续：默认仍为 `lab-note/1`；新增显式 `NORMAL_TODO_PROFILE`（`lab-normal-todo/1`）处理普通待办单条 `put/delete`，复用实际普通任务规则，贯通初始化／提交／恢复；其他集合仅透传。[本轮结果](../../docs/record-sync-normal-records-results.md)记录 362 项联合回归、真实退出及边界。应用未启用新模式。

```powershell
node tools/record-sync-protocol-lab/run-normal-records.mjs 新报告路径.json
node --test tools/record-sync-protocol-lab/tests/test-normal-records.mjs
node --test tools/record-sync-protocol-lab/tests/test-normal-records-durable.mjs
```

初始化、加入、`openRecordLab` 和恢复须显式传入 `profile: NORMAL_TODO_PROFILE`；省略仍按 notes 处理并在高层描述符核对时拒绝普通业务数据集，不根据远端内容自动换规则。新增实验 Schema 兼容旧身份，UUIDv4 新身份由上下文验证。下文“唯一 lab.note.set／仅 notes”描述默认集合及早期范围，不作为新增集合的能力限制；旧报告保持原样。

## 运行

业务端到端实盘用例使用自建对象目录及测试子进程，运行 `node --test tools/record-sync-protocol-lab/tests/test-business-e2e.mjs`。[业务验收](../../docs/record-sync-collaboration-boundary-results.md#业务端到端隔离验收)

真实 WebDAV 业务隔离用例使用已配置连接，运行 `node tools/record-sync-protocol-lab/run-business-live.mjs --execute 尚不存在的报告路径.json`。合成文件夹副本测试运行 `node --test tools/record-sync-protocol-lab/tests/test-folder-record-scan.mjs`。[隔离实测与边界](../../docs/record-sync-collaboration-boundary-results.md#坚果云隔离实测)

在项目根目录使用 Node 24（本次验证为 24.17.0）：

```powershell
node --test tools/record-sync-protocol-lab/tests/test-*.mjs
node tools/record-sync-protocol-lab/run-simulation.mjs
node tools/record-sync-protocol-lab/run-simulation.mjs docs/record-sync-protocol-lab-simulation-new.json
```

报告路径必须不存在，避免覆盖既有证据。`run-simulation.mjs` 的传输、文件对象和状态存储在内存替身中，不读取应用配置、凭据或正式数据，不发送网络请求，唯一真实文件写入是显式指定的报告；其中的实例重开不是实际进程退出。完整测试集后续已包含真实 FileStore 和真实子进程场景，不能概括为全部只用内存。

以上描述限于 Node 模拟命令。后续已新增独立 Rust／Kotlin 编码与封装实验，构建会产生本地编译文件；首次准备依赖可能访问软件包源，不访问待办 WebDAV 服务或真实清单。三端验证命令：

```powershell
# 先用本机缓存重建两个实验程序，再对照全部共享语料
./tools/record-sync-protocol-lab/run-interop.ps1 docs/record-sync-protocol-interop-new.json

# 已构建后只重跑对照
node tools/record-sync-protocol-lab/run-interop.mjs
```

结果与边界见[三语言实验结论](../../docs/record-sync-protocol-interop-results.md)。本轮三端各 422 个请求通过，含 45 个原评分／复盘业务请求；这些独立程序没有接入 Windows／Android 应用。

真实文件、恢复包与当前服务隔离验证见[最新验证结果](../../docs/record-sync-storage-network-results.md)：

```powershell
node tools/record-sync-protocol-lab/run-durability.mjs 新报告路径.json
node tools/record-sync-protocol-lab/run-recovery-durable.mjs 新报告路径.json
# 只向当前配置下的新随机隔离目录发送合成数据，测试后核对清理
node tools/record-sync-protocol-lab/run-live.mjs --execute 新报告路径.json
```

真实文件测试会在工作区创建带归属标记的 scratch 目录，核对绝对路径与归属后清理；不访问正式待办。实测 runner 复用既有配置运行器，在内存处理凭据，报告隐藏正式父目录；它是唯一会访问已配置待办服务的新增入口。测试进程退出不是断电证明。

## 覆盖范围

| 文件 | 验证职责 |
| --- | --- |
| `codec.mjs` | UTF-8／规范 JSON 字节；解析前检查重复键，校验 Unicode、数值、大小与深度；按 UTF-16 键序编码 |
| `envelope.mjs` | descriptor／baseline 固定绑定、哈希文件名、严格字符串 UUID／hash、父引用、迭代拓扑与稳定记录排序 |
| `initialization.mjs` | baseline 先发布，descriptor 请求前保存尝试证据，邀请返回前保存暴露证据，结果未知不可回退，只读精确加入 |
| `client.mjs` | 原子状态接口、固定 outbox、读回确认、精确补父、持久公平轮转、异常证据与冻结、完整已知记录冷恢复 |
| `run-simulation.mjs` | 合成数据集的组合场景，输出检查结果和明确限制 |
| `vectors.json` | [RFC 8785 附录 B](https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B)的 24 个有限 binary64 数值样本 |
| `wire-vectors.json` | Node 参考生成的 5 个固定基线／描述符／记录字节、哈希及文件名，供后续独立实现读取 |
| `file-store.mjs`、`durability-worker.mjs` | 完整状态原子写盘与六种真实进程退出／终止，单活协作式 lease |
| `recovery.mjs`、`run-recovery-durable.mjs` | 完整已知证据包并集恢复，不用旧包覆盖新增记录，不信任缓存投影 |
| `webdav-transport.mjs`、`run-live.mjs` | 当前配置的新随机隔离目录传输，固定字节核对后拆除本次测试资源 |
| `normal-todo.mjs`、`normal-todo-vectors.mjs` | 普通 Todo 已确认规则：整条实际时间优先，归一业务内容固定平局；三端 `business: todo` 对照 |
| `checkin-probe/`、`run-checkin-validation.mjs` | 只读核对 Windows 当前打卡函数与抽取的 Kotlin 原函数；发现差异不自动修改规则 |

编码按 [JCS](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2) 和 [I-JSON](https://www.rfc-editor.org/rfc/rfc7493.html#section-2)约束实现实验配置。输入上限为 1 MiB、嵌套深度 128；这不是生产规模配置。只接收已规范化的网络字节，拒绝非规范数字与键顺序，不能用于自动舍入旧文件中的未知数字。传给 `encode()` 的 JavaScript 数值已经是 binary64，无法找回调用者此前丢失的精度。

`wire-vectors.json` 是固定的 Node 参考产物，文件状态描述其生成时的证据范围，不回改历史输入。后续 Rust／Kotlin 已在共享语料中从相同输入独立产生相同字节和哈希，并核对相应负例，见三语言报告；这仍不是生产协议的独立认证或应用集成证据。

协议标识使用草案的 `todo-record-sync/1`，但 `operation_set` 固定为 **`lab-note/1`**。唯一记录操作是 `lab.note.set`，数据只含合成 notes 与扩展；这里的 `data_schema_version: 1` 不表示符合生产 `todo_data.schema.json`。工具会拒绝生产 Todo、评分等记录操作。互通工具另有 `business` 请求验证合法完整评分／复盘样本的原归并规则，不是正式业务操作接入；计划 DAG、完整迁移和协作权限均未实现。没有新增生产 Schema，也不应把本目录复制为应用存储实现。

## 状态与传输接口

`store.load()/save(state)` 是实验注入的原子状态替换接口。MemoryStore 不提供互斥；FileStore 增加协作式 wx lease，但不提供 OS 强锁、跨设备互斥或 CAS。每个 store 只允许一个活动实例，重开前关闭旧实例；死进程接管只允许单一协调器核对 PID／token 后显式执行。保存已生效但返回失败时，客户端下一次动作先重读状态，防止旧内存覆盖已保存记录和故障证据。FileStore 实验整状态上限为 1 MiB，未验证大包与断电。

`transport.read(name)` 返回 Buffer 或 `null`，`write(name, bytes)` 发送固定字节，客户端另需要 `list()`。适配器预先绑定单一数据集目录，工具不根据账号、目录时间或最新指针自动切换数据集。实验 pin 只覆盖命名空间和内容身份，**尚不含真实 endpoint、账号／凭据引用及目标代次门禁**；这些仍须由正式仓库实现验证。

每轮最多尝试 256 个读取对象。待读队列持久保留，读之前把当前项移到队尾；漏项、前缀持续失败及重复目录不会永久饿死尾项。定期全量重扫仍必需；遗漏且没有任何已知后继引用的独立根记录无法凭空发现，因此报告始终标记 `listingCompleteness: unknown`。

无效记录、未知操作、同 ID 异体及错误父哈希保留证据并冻结提交。冻结视图是此前发布的暂时结果，可能包含争议内容，不能用作新基线或完整恢复依据。自动修复坏记录、清理日志、压缩和轮换均未提供。

## 结果与后续门槛

本轮结论和报告见[协议实验结果](../../docs/record-sync-protocol-lab-results.md)。业务取舍见[语义评审](../../docs/record-sync-semantics-review.md)、[ADR-0002](../../docs/adr/0002-first-release-rating-review-collaboration.md)及 [ADR-0003](../../docs/adr/0003-normal-todo-deterministic-whole-record.md)：评分／复盘原规则不变，普通 Todo 整条实际时间优先、同时间归一业务固定平局。原字段增量及普通 Todo 删除单调方案不作为第一版默认。

Rust／Kotlin 独立编码及封装、真实文件／进程退出、小恢复包与隔离 WebDAV 已完成对应实验。普通 Todo 扩展后最新三端各 499 个请求通过，Node 联合最终 320 项通过，见[新结果](../../docs/record-sync-normal-todo-results.md)。用户明确本次只调整普通 Todo，[其他类别](../../docs/record-sync-remaining-ties.md)不自动扩展，周／月打卡额外规则单独验证；未擅自修改生产应用。初始化、规模、完整业务、迁移、协作及本地同步盘仍是独立门槛。

打卡额外函数已完成[独立源码验证](../../docs/record-sync-checkin-validation.md)，发现亚毫秒与输出顺序差异以及等长记录角色方向性。此报告不是“全部通过”，规则保持原样。复现命令：

```powershell
./tools/record-sync-protocol-lab/checkin-probe/build.ps1
node tools/record-sync-protocol-lab/run-checkin-validation.mjs 新报告路径.json
```
