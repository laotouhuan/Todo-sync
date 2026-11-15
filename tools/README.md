# WebDAV 同步能力验证

用于[周计划实施方案](../docs/weekly-plan-daily-rating-implementation-plan.md)阶段 0，独立于应用运行。模拟测试通过不代表真实 WebDAV 服务具备条件写能力。

条件写／LOCK 补测后的候选实验见[独立记录文件同步原型](record-sync-prototype/README.md)，其[验证结论](../docs/record-sync-prototype-results.md)单独记录。它不改变下述能力测试的失败结论，也没有接入应用。

正式候选设计新增要求的模拟验证见[协议实验工具](record-sync-protocol-lab/README.md)及[结果与限制](../docs/record-sync-protocol-lab-results.md)。后续[三语言实验](../docs/record-sync-protocol-interop-results.md)已对照编码、封装和原评分／复盘的有限样本；它们都不是新一轮真实 WebDAV 实测或应用集成验收。

更新：[真实文件、恢复包与新协议隔离 WebDAV](../docs/record-sync-storage-network-results.md)已完成限定验证；普通 Todo 已按用户确认的[整条固定平局规则](../docs/adr/0003-normal-todo-deterministic-whole-record.md)完成[三端扩展验证](../docs/record-sync-normal-todo-results.md)。本次只调整普通 Todo，[其他类别](../docs/record-sync-remaining-ties.md)不自动扩展，周／月打卡额外规则单独验证。既有条件写／LOCK 的失败结论不变，不能把独立记录实测当作条件覆盖路径通过。

## 本地测试

在项目根目录执行：

```powershell
node --test tools/tests/test-*.mjs
```

无需安装额外依赖。使用支持内置 `fetch` 的 Node.js 18 或更高版本。

## 验证当前 Windows 应用连接

补充验证条件更新、独占锁及首次创建，使用：

```powershell
node tools/run-configured-webdav-preflight.mjs --execute --extended docs/webdav-extended-result.json
```

补测入口分别调用 `verify-webdav-if-match.mjs` 和 `verify-webdav-lock.mjs`，各用独立资源。一种机制失败仍执行另一种机制；只有一条路径的全部必需能力通过，才将该路径列为候选。已有文件更新通过而首次创建失败，或锁过期／响应恢复项目未执行，都不能算完整路径通过。详细用例见[阶段 0 补充验证标准](../docs/weekly-plan-stage0-supplemental-tests.md)。

原快速验证入口保留，遇到首个必要条件失败会终止该轮：

```powershell
node tools/run-configured-webdav-preflight.mjs --execute docs/webdav-preflight-result.json
```

该命令读取当前用户的 Todo-sync Windows 配置，使用应用既有规则在内存中解密凭据，在正式待办文件的父目录下创建随机隔离目录。不会读取或写入正式待办文件，不改应用配置；报告不包含账号、密码、实际 ETag 或正式数据路径。报告文件必须不存在，避免覆盖既有证据。

这些命令会向已配置服务发送隔离测试写请求。每次运行创建不同的目录及文件；清理仅针对本次资源。清理集合前确认其为空，避免 WebDAV 集合删除递归影响其他文件；文件删除后 GET、集合删除后 PROPFIND 均须读回 `404` 才确认移除。创建结果未知时保留并报告随机路径，不强制删除。清理失败时核对报告中的残留路径，不手工递归删除其他目录。

锁过期验证按服务端实际授予的期限等待，默认等待预算 20 秒；无限期限或超过预算时报告未执行。具备前置能力时，扩展锁探测还会主动跳过一次发送、丢弃一次实际响应，分别检查 LOCK／PUT／UNLOCK 的恢复，不将纯模拟测试结果当成真实服务验证。

## 验证其他服务

`verify-webdav-conditions.mjs` 的 CLI 从以下环境变量读取连接信息：

| 变量 | 含义 |
| --- | --- |
| `WEBDAV_ENDPOINT` | 不含账号、查询参数和片段的 HTTPS 目录 URL，末尾为 `/` |
| `WEBDAV_PREFLIGHT_DIRECTORY` | 已存在的相对隔离目录，最后一级为 `codex-webdav-preflight` |
| `WEBDAV_USERNAME` | WebDAV 用户名 |
| `WEBDAV_PASSWORD` | WebDAV 应用密码，仅在进程中使用 |

配置后执行：

```powershell
node tools/verify-webdav-conditions.mjs
```

不要将真实凭据写入脚本、报告或提交到仓库。该入口不创建目录，只操作隔离目录下本次随机生成的 `probe-UUID.json`，不接受正式文件名或目录穿越路径。

## 判定与清理

- `passed`：条件创建拒绝覆盖已有文件，不匹配的有效 ETag 被拒绝，强 ETag 更新及过期凭据拒绝成立，双客户端竞争恰有一方写入成功，读回内容正确。
- `unsupported`：本次测试观察到与上述要求矛盾的行为，例如忽略条件头或未提供可用强 ETag。结论仅适用于受测连接及测试时点，不推断其他服务或其他并发控制机制的能力。
- `inconclusive`：网络、权限、配置等原因导致无法确认。不能据此判定支持。
- `not-executed`：分项因缺少前置条件或期限超过等待预算而未执行。补测报告保留原因，不将其归为通过或推断不支持。

退出码 `0` 同时要求验证通过且测试资源清理成功；退出码 `1` 表示未通过、未完成或清理失败；通用验证入口参数错误返回 `2`。清理只在读回的随机标记与本次一致时删除测试文件；无强 ETag 时使用 `If-Match: *` 清理不改变能力判定，删除后读回 `404` 才确认文件已清理。

默认服务未通过时，按实施方案暂停 Schema 和功能接入，先调整并重新审核同步设计；不得静默改回无条件整文件上传。
