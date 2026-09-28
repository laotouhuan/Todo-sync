# 当前建议实施的修正清单

核对日期：2026-09-26。

本文仅保留有明确收益的七项修正。第 2 项是数据安全问题修复，其余为测试改进、小范围重构或维护清理；第 4 项依赖第 1 项。七项代码及文档修改已执行，自动化检查通过；CSS 已完成静态核验，尚未完成视觉验收，详见文末“实施记录”。当前方案没有改变共享数据字段或 Schema。

| 顺序 | 修正内容 | 完成标准 |
| --- | --- | --- |
| 1 | Windows 合并／迁移测试直接引用生产实现 | 删除对应测试副本，现有边界用例执行生产代码 |
| 2 | Android 协作配置写入失败时保留原数据和迁移源 | 写入失败不清空旧配置、不发布成功状态、不继续上传 |
| 3 | Android 健康统计提取纯函数 | 固定时间和时区即可直接测试健康指标 |
| 4 | 补充少量跨端共享 JSON 样例 | 两端读取同一份样例，验证默认值和已有扩展字段保留 |
| 5 | 删除 Windows 完全重复的 CSS | 删除一份重复块，相关界面外观与交互保持一致 |
| 6 | 补全发布版本一致性检查 | 四处应用版本和发布标签不一致时，在构建前失败 |
| 7 | 统一测试入口并修复文档失效链接 | 根脚本调用包脚本，仓库内链接可随目录迁移 |

## 1. Windows 合并／迁移测试直接引用生产实现

**现状与收益：**[main.js](../windows/src/main.js) 的 `migrateAndNormalize()`、`mergeTodoData()` 等函数在 [test-dataLogic.mjs](../windows/tests/test-dataLogic.mjs) 中存在测试副本，且已经分叉：生产迁移会修剪标签、把 `completed: null` 转为 `false`，副本没有这些处理；副本的数据比较快照也缺少 `time_entries` 和 `daily_reviews`。后段 AST／VM 测试只覆盖部分生产行为。

**具体修改：**

1. 新建 `windows/src/dataMerge.js`，迁入 `migrateAndNormalize()`、`resolveCheckinConflict()`、`mergeReminderSettings()`、`mergeTodoData()`、`mergeCollaborations()`，以及数据快照、稳定比较等直接依赖的内部函数。仅导出调用方需要的入口。
2. `getWeeklyCompletedCount()`、`getMonthlyCompletedCount()` 同样从 `main.js` 移入该模块并导出，供合并和现有 UI 共用。模块使用现有 `dateUtils.js`、`timeTracking.js`；深拷贝沿用 `structuredClone()`。该模块不读取 DOM、Tauri 或 `appState`。
3. 在 `main.js` 顶部导入迁出的入口，删除原定义，保持现有调用、数据修改方式、时间戳和冲突规则。不要借移动代码改变普通待办的同时间戳取本地、打卡销卡、学习记录平局等规则。
4. `test-dataLogic.mjs` 顶部直接导入生产入口，删除对应副本，并将原有迁移、合并和内容比较用例全部切换到这些入口。把“学习数据实际合并入口”的 AST 提取改为直接调用；页面测试仍使用 VM 的地方，改为注入迁出的生产函数，保持原有页面回归覆盖。
5. 补齐直接验证生产代码的用例：标签规范化、`completed: null`、无目标次数时完成状态为布尔值、仅计时或复盘变化也触发内容变化、旧数据默认值、提醒设置和协作删除标记合并。保留原有补卡／销卡、相同时间戳和离线合并用例；发现旧断言与生产实现不同，应核对契约后处理。

**验收：**合并／迁移用例不再执行测试内复制的实现；新增模块没有运行时 UI 依赖。运行根目录 `./run-tests.ps1`，通过两端同步相关门禁。

## 2. Android 协作配置写入失败时保留原数据和迁移源

**现状与收益：**[TodoRepository.kt](../android/app/src/main/java/com/todo/app/data/repository/TodoRepository.kt) 的 `writeCollaborationsFile()` 在重命名失败后直接覆盖目标文件，并捕获后吞掉写入异常。`loadCollaborationsLocally()` 随后仍清空旧 SharedPreferences；导入、删除、同步调用方也可能继续发布状态或上传。这是失败路径上的数据安全问题，应独立修复。

**具体修改：**

1. 复用 [PersonalDataStore.kt](../android/app/src/main/java/com/todo/app/data/repository/PersonalDataStore.kt) 中现有的 `AtomicJsonFile` 写入 `collabFile`，删除固定的 `collabTmpFile` 和直接打开目标文件覆盖的回退路径。临时写入或原子替换失败时保留原文件，并把失败传回调用方。
2. 迁移时仅在新文件成功写入后清空 `configManager.collaborations`。失败时保留旧配置、结束本次迁移并报告失败，使下次加载能够重试。
3. 核对 `importCollaboration()`、`deleteCollaboration()`、`syncCollaborations()` 的全部写入调用。只有写入成功才发布 `collaborations` 状态、发起后续上传或返回成功。导入沿用外层异常处理返回 `Result.failure`；删除补齐对应异常处理；同步在本地提交失败时停止。初始化迁移和后台同步的启动处接住失败并记录／报告，避免异常无人处理；所有新增异常捕获均重新抛出 `CancellationException`。保留原有锁、合并和软删除规则。
4. 使用现有原子文件测试的故障注入方式覆盖临时文件写入失败、替换失败和正常成功。再验证调用顺序：失败保留原文件和旧偏好、不更新 Flow、不上传；重试成功后才清空迁移源，重复加载不产生重复记录。测试执行实际写入／迁移入口，不复制迁移算法到测试中。

**验收：**模拟磁盘写入或替换失败仍能保留已保存配置和迁移源。执行 Android `lintDebug testDebugUnitTest`；本项只修复提交失败处理，保持协作数据格式不变。

## 3. Android 健康统计提取纯函数

**涉及文件：**[TodoViewModel.kt](../android/app/src/main/java/com/todo/app/ui/viewmodel/TodoViewModel.kt)、[StatsUtils.kt](../android/app/src/main/java/com/todo/app/data/model/StatsUtils.kt)、[StatsUtilsTest.kt](../android/app/src/test/java/com/todo/app/data/model/StatsUtilsTest.kt)。

**具体修改：**

1. 将目前定义在 `TodoViewModel.kt` 的 `HealthMetrics` 数据类移入 `StatsUtils.kt` 所在的 model 包，保持字段和默认值，调整引用。
2. 在 `StatsUtils.kt` 新增 `calculateHealthMetrics(todos: List<Todo>, now: Instant, zone: ZoneId): HealthMetrics`，迁入 `healthMetrics` Flow 内的计算。由同一个 `now` 推导当前时刻和指定时区的今日零点，函数内部不读取系统当前时间。
3. 保留现有任务排除条件、空集合回退、七天沉睡阈值、完成时间与创建时间各自的解析规则。健康统计的兼容解析仍作为私有辅助函数；调用 `calcTaskAgeDays()` 时显式传入参考时刻，保留无效创建时间返回 `-1`、未来时间截断为 `0` 的语义。其 Instant 解析回退可使用传入参考时刻的 offset，消除隐式设备时区读取，同时保持时间差结果。
4. ViewModel 的 `map` 只获取当前 `Instant`、设备 `ZoneId` 并调用新函数；保留现有 `flowOn`、`stateIn` 和订阅策略。
5. 补充固定输入测试：空列表；删除、周／月打卡及每日重复任务排除；今日零点前后创建／完成；UTC 时间在本地跨日；纯日期与异常时间戳回退；基线无样本；刚好七天的沉睡边界。

**验收：**测试直接调用生产函数，固定 `now` 与 `zone` 后结果稳定，已有健康统计口径保持不变。执行 Android `lintDebug testDebugUnitTest`。

## 4. 补充少量跨端共享 JSON 样例

**现状与收益：**两端已有内联兼容测试，但没有共享 JSON 样例。补少量共同输入，可以检查两端对同一文件的默认值和扩展数据处理是否一致。

**具体修改：**

1. 在仓库根目录新增 `tests/fixtures/contract/`，先放三份人工构造的样例：`legacy-personal.json`、`current-personal.json`、`current-collaboration.json`。这些名称避开现有个人数据忽略规则。
2. 旧版个人样例保留两端已支持的基础字段，覆盖缺失提醒设置、计时、复盘等后加字段的情况；当前个人样例包含任务／子任务、纯日期与带时间打卡记录、提醒、计时和复盘；协作样例包含有效源及删除标记。使用固定 UUID、时间戳和虚构内容，凭据使用无效占位值。
3. Windows 在 `test-dataLogic.mjs` 中通过基于 `import.meta.url` 的文件路径读取样例，调用第 1 项抽出的生产入口。Android 在 `android/app/build.gradle.kts` 的单元测试资源配置中加入 `../../tests/fixtures`，测试通过 classpath 读取 `contract/` 下同一批文件。
4. 在现有 Windows 数据测试和 Android `SerializationTest.kt`／`MergeLogicTest.kt` 中增加定向断言：旧字段默认值符合约定；当前个人数据经过加载、归一化及合并后，提醒、计时、复盘仍保留；Android 编解码往返后字段值保持；协作删除标记保留。比较明确的字段和语义，动态生成的根更新时间单独断言。
5. 旧样例验证既定兼容行为；当前样例依据现有 Schema，用现有断言工具定向检查必填字段、类型及日期／时间格式。当前构建门禁只检查 Schema 本身结构，这些定向断言也不等于完整 JSON Schema 实例校验。若发现两端行为差异，记录具体差异后单独处理，不为使样例通过而修改兼容规则。样例覆盖当前已定义字段的保留，不承诺未知字段的完整往返保留。

**验收：**两端测试确实读取同一份文件，正常测试命令能运行新增用例。执行根目录 `./run-tests.ps1`。

## 5. 删除 Windows 完全重复的 CSS

**涉及文件：**[styles.css](../windows/src/styles.css)。核对时第 2141–2332 行与第 2335–2526 行是逐字符相同的 192 行块，包含复选框悬停、开关、输入联想和协作样式。

**具体修改：**

1. 修改前按选择器和声明再次确认两块相同，删除前一份，保留后一份原位，保持最终生效规则的级联顺序。
2. 核对删除边界与相邻注释、花括号；此次只删除重复块。
3. 在浏览器预览中检查复选框悬停、开关开／关、输入联想列表和协作界面，对比修改前后的外观与操作。

**验收：**重复块只保留一份，视觉和交互一致。在 `windows/` 执行 `npm run check` 和 `npm run test`，并完成上述界面检查。

## 6. 补全发布版本一致性检查

**涉及文件：**[release.yml](../.github/workflows/release.yml) 的 `Check release version` 步骤。当前仅比较 Tauri、Android 和发布标签，漏掉另外两处 Windows 版本。

**具体修改：**

1. 扩展该步骤已有的 Node 校验代码，读取并比较以下四个值：
   - `windows/package.json` 的 `version`；
   - `windows/src-tauri/Cargo.toml` 的 `[package].version`；
   - `windows/src-tauri/tauri.conf.json` 的 `version`；
   - `android/app/build.gradle.kts` 的 `defaultConfig.versionName`。
2. JSON 使用现有解析方式；Cargo 读取限定在 `[package]` 区段，避免误取依赖版本；Gradle 读取限定在 `defaultConfig`。字段缺失、为空、存在歧义或四者不相等时，以非零状态退出，并打印对应文件及值。
3. 保留已有的 `v<version>` 标签检查和 `GITHUB_OUTPUT` 输出，使后续构建、安装包命名继续使用已验证版本。
4. 在临时副本中验证：四值相同通过；分别改错任意一处、删除字段、提供不匹配标签均失败；手动触发时仍检查四个版本。保留 Android `versionCode` 每次发布递增的要求，递增必须以上一次已发布值为参照，不能用当前版本一致性检查替代。

**验收：**版本漏改会在签名和构建之前被发现，工作流输出格式保持一致。核对 YAML 和上述通过／失败路径，无需为校验逻辑实际发布安装包。

## 7. 统一测试入口并修复文档失效链接

**涉及文件：**[run-tests.ps1](../run-tests.ps1)、[AGENTS.md](../AGENTS.md)。

**具体修改：**

1. 将根脚本中的 `node tests/check-build.mjs` 改为 `npm run check`，相应日志改为包脚本名称。保留原来的工作目录、`$LASTEXITCODE` 检查、失败汇总、Windows 测试和 Android 检查顺序。
2. 将 `AGENTS.md` 中指向旧 `D:\aaa\project\to-do list` 的五处 `file:///` 链接改为相对链接：`run-tests.ps1`、`windows/package.json`、`windows/src-tauri/Cargo.toml`、`windows/src-tauri/tauri.conf.json`、`android/app/build.gradle.kts`。链接文字保持可读，保留其余规范内容。
3. 核对五个目标文件均存在；执行 `./run-tests.ps1`，确认它通过包脚本进入 Windows 检查，任一阶段失败仍以失败退出。

**验收：**检查命令只有一处包脚本定义，仓库换目录后链接仍能访问。若只实施链接修复，核对链接与格式即可；改测试入口后运行全平台脚本。

## 实施与验证约定

- 每项独立修改和验证；第 4 项依赖第 1 项的 Windows 生产模块入口。代码引用以函数名和当前文件内容为准，CSS 行号仅作为定位参考。
- 本次清单不需要修改共享字段、Schema 或发布版本值；若实施时发现需要改变数据语义，应单独记录问题，先核对两端契约。
- Android 检查在 `android/` 执行：先设置 `$env:JAVA_HOME = "D:\android studio\jbr"`，再运行 `.\gradlew.bat lintDebug testDebugUnitTest`。根目录 `./run-tests.ps1` 会运行 Windows 前端与 Android 门禁。
- 仅编辑本文时，核对内容、路径、链接与格式即可，无需运行应用测试。

## 实施记录

- 七项代码及文档修改已实施；版本配置中的 `1.5.1` 与 `versionCode = 37` 来自原工作区，本次保留原值。CSS 视觉验收仍未完成。
- 初次实施已通过根目录 `./run-tests.ps1`；本次补测后分别运行 Windows `npm run check`、`npm run test` 和 Android `lintDebug testDebugUnitTest`，全部通过：Windows 183 项、Android 124 项测试，零失败。
- Windows 恢复两项直接调用生产合并入口的回归测试：标签冲突后候选列表只包含获胜值；同日异 ID 复盘归一及新增计时触发同步。两者均验证交换合并方向后的数据结果。
- Android 将协作配置的迁移、导入、删除与合并提交步骤集中到已有的 [CollaborationDataFile.kt](../android/app/src/main/java/com/todo/app/data/repository/CollaborationDataFile.kt)，让 [CollaborationDataFileTest.kt](../android/app/src/test/java/com/todo/app/data/repository/CollaborationDataFileTest.kt) 直接执行生产业务入口。8 项测试覆盖临时写入／替换失败、旧偏好保留、重试及重复迁移去重、失败 Result、真实 StateFlow、同步排队和上传副作用、读取失败与取消传播。Repository 继续持有原有锁、解密和网络处理，没有新增框架或依赖。
- Android [SerializationTest.kt](../android/app/src/test/java/com/todo/app/data/repository/SerializationTest.kt) 新增共享个人样例的双向生产合并测试，验证较旧的提醒、计时和同日异 ID 复盘不会覆盖样例中的较新记录，保留原有序列化往返测试。
- 发布版本脚本在临时副本中验证了四处版本匹配、四处各自不匹配、缺失 Android 版本、错误标签及分支手动运行；预期通过/失败均符合。
- CSS 相对基线 `f063a4c` 的静态比对通过：原第 2141–2332 行与第 2335–2526 行的 192 行块完全相同，当前文件恰好只删除前一块，其余内容及保留规则的顺序不变。前端也未发现依赖 CSSOM 规则索引的访问。按用户要求停止使用 computer-use；未完成的浏览器视觉与交互验收不计为已通过。
