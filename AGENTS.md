# AGENTS.md — AI 编码助手上下文指南

> 本文件为 AI 编码助手提供项目上下文，帮助快速理解项目结构、技术栈和核心设计决策。
> **人类开发者同样可以参考此文件快速上手项目。**

---

## 1. 项目概述

**Todo-sync** 是一个跨平台待办事项应用，支持 **Windows 桌面端** 和 **Android 移动端**，通过共享 JSON 数据文件实现双端数据同步。

### 核心能力

- 待办事项的增删改查（CRUD）
- 子任务（Subtasks）
- 每日重复任务（`recurring: daily_repeat`）与周/月打卡任务（`task_type`）
- 软删除（Soft-delete，`deleted` 标记）
- 日期/时间/排序
- 统计视图（按日/周/月）
- 数据备份与恢复
- 云同步（文件夹同步 + WebDAV）
- 协作清单与共享码
- 任务提醒与全局提醒规则
- 学习计时、任务标签、每日复盘与 Markdown 导出
- 完成记录与计时的钟面/纵向时间线

---

## 2. 项目结构

```
to-do list/
├── AGENTS.md                  # 本文件
├── todo_data.schema.json      # ★ 待办、提醒、计时、复盘的数据契约
├── collaborations.schema.json # ★ 协作源配置的数据契约
├── run-tests.ps1              # 两端测试入口
├── user_guide.md              # 功能与使用说明
├── android/                   # Android 端（Kotlin + Jetpack Compose）
│   └── app/src/
│       ├── main/java/com/todo/app/
│       │   ├── MainActivity.kt
│       │   ├── TodoApplication.kt
│       │   ├── WidgetAddActivity.kt
│       │   ├── data/
│       │   │   ├── model/     # Todo、TodoData、MergeUtils、Learning、Collaboration 等
│       │   │   ├── repository/TodoRepository.kt
│       │   │   ├── ConfigManager.kt
│       │   │   └── WebDavClient.kt
│       │   ├── ui/
│       │   │   ├── view/      # 待办、设置、统计、计时复盘、时间线与动画
│       │   │   ├── theme/     # Material 主题
│       │   │   └── viewmodel/TodoViewModel.kt
│       │   ├── notification/  # 提醒调度、接收器、通知与权限
│       │   ├── utils/AppUpdater.kt
│       │   └── widget/        # TodoWidget.kt、TodoWidgetProvider.kt
│       └── test/java/com/todo/app/ # data/model、data/repository、ui/view 测试
└── windows/                   # Windows 端（Tauri 2）
    ├── src/                   # 前端（纯 HTML/CSS/JS，无框架）
    │   ├── index.html
    │   ├── main.js            # 应用状态、交互、待办迁移与合并、协作入口
    │   ├── dateUtils.js       # 日期、任务创建与分组
    │   ├── timeTracking.js    # 计时、标签、学习记录归一化与合并
    │   ├── reviewUtils.js     # 复盘预览与 Markdown 导出
    │   ├── learningView.js    # 计时与复盘界面
    │   ├── reminderRuleUtils.js # 全局提醒规则计算
    │   ├── statsTimeline.js   # 时间线数据、时刻与几何计算
    │   ├── statsTimelineView.js # 钟面时间线渲染
    │   ├── statsVerticalView.js # 纵向时间线渲染
    │   ├── clockAnimation.js  # 钟面出场动画
    │   ├── tauri-mock.js      # 浏览器预览用 Tauri 模拟接口
    │   ├── styles.css         # 样式
    │   └── Sortable.min.js    # 拖拽排序库
    ├── tests/                 # 构建门禁与 test-*.mjs 测试
    └── src-tauri/             # 后端（Rust）
        ├── Cargo.toml
        ├── tauri.conf.json    # Tauri 配置
        └── src/
            ├── main.rs        # 入口
            ├── lib.rs         # Tauri 插件注册、系统托盘、全局快捷键、文件监听
            └── todo_store.rs  # 数据持久化、文件锁、备份、WebDAV 同步
```

---

## 3. 技术栈

| 平台 | 语言 | 框架 / 工具 | 架构模式 |
|------|------|-------------|----------|
| **Windows** 前端 | JavaScript (ES Module) | 无框架，纯 Vanilla JS | 命令式 DOM 操作 |
| **Windows** 后端 | Rust | Tauri 2 | Tauri Command 暴露 API |
| **Android** | Kotlin | Jetpack Compose + Material 3 | MVVM（Repository → ViewModel → Composable） |

### 关键依赖

**Windows (Rust/Tauri)**：
- `tauri` v2（含 `tray-icon` 特性）
- `tauri-plugin-global-shortcut` v2 — 全局快捷键 `Ctrl+Shift+Space`（快速添加）、`Ctrl+Shift+T`（显示/隐藏）
- `notify` v6 — 文件变更监听
- `fs2` — 文件锁（读共享锁 / 写排他锁）
- `reqwest` — WebDAV HTTP 请求
- `serde` / `serde_json` — JSON 序列化

**Android (Kotlin)**：
- Jetpack Compose + Material 3
- `kotlinx.serialization` — JSON 序列化
- Gradle 使用阿里云镜像源

---

## 4. ★ 数据契约（最重要）

两端共享同一个 JSON 数据文件 `todo_data.json`，其结构由 `todo_data.schema.json` 定义。协作源配置另存于 `collaborations.json`，遵循 `collaborations.schema.json`。

### 数据结构摘要

```jsonc
{
  "version": 1,                    // 数据版本号（整数）
  "last_updated": "ISO 8601",     // 最后更新时间
  "todos": [
    {
      "id": "UUID",               // 唯一标识（UUID v4）
      "content": "string",        // 待办内容（必填）
      "date": "string | null",    // 日：YYYY-MM-DD；周：YYYY-Www；月：YYYY-MM；无日期为 null
      "time": "string | null",    // 截止时间
      "completed": false,         // 是否完成（必填）
      "completed_at": "ISO 8601 | null",  // 完成时间
      "created_at": "ISO 8601",   // 创建时间（必填）
      "updated_at": "ISO 8601",   // ★ 冲突解决依据
      "order": 0.0,               // 排序权重（数字）
      "deleted": false,           // 软删除标记
      "recurring": "none",        // 每日重复（兼容遗留字段）：none | daily_repeat
      "task_type": "normal",      // 任务类型：normal | weekly_checkin | monthly_checkin
      "completed_dates": [],      // 打卡记录：兼容 YYYY-MM-DD 与包含时间的 ISO 8601 字符串
      "target_count": null,       // 目标打卡次数（整数或 null）
      "label": null,              // 单个任务标签；null 表示未分类
      "reminder": null,           // 单任务提醒，缺省为 null，结构见下表
      "subtasks": [               // 子任务列表
        { "id": "UUID", "content": "string", "completed": false, "completed_at": "ISO 8601 | null" }
      ]
    }
  ],
  "reminder_settings": {          // 全局提醒配置；旧文件缺失时补齐这些默认值
    "updated_at": null,
    "enabled": true,
    "privacy_mode": false,
    "global_rules": []
  },
  "time_entries": [],             // 学习计时记录；旧文件缺失时默认为 []
  "daily_reviews": []             // 每日复盘记录；旧文件缺失时默认为 []
}
```

上例是字段摘要；完整属性、类型和必填项以 Schema 为准。扩展数据的结构与兼容默认值如下：

| 数据 | 结构与默认值 |
|------|-------------|
| `todos[].reminder` | 默认 `null`；设置时包含必填 `reminder_time`，可选 `reminder_date` 默认 `null`、`repeat_daily` 默认 `false` |
| `reminder_settings.global_rules[]` | 规则含 `id`、`time`；`enabled` 默认 `true`、`condition` 默认 `unconditional`、`task_scope` 默认 `all`、`title` / `body` 默认空字符串 |
| `time_entries[]` | 含 `id`、`created_at`、`updated_at`、`task_ref`、`started_at`；`deleted` 默认 `false`、`ended_at` 默认 `null`（仍在计时）、`task_content_snapshot` 默认空字符串、`label_snapshot` 默认 `null` |
| `time_entries[].task_ref` | `todo_id` 必填；`source_type` 默认 `personal`，另可为 `collaboration`；`source_id` 默认 `null`，引用协作任务时记录协作源 ID |
| `daily_reviews[]` | 含 `id`、`date`（YYYY-MM-DD）、`created_at`、`updated_at`；`deleted` 默认 `false`；`fact`、`obstacle`、`effective_action`、`next_step` 默认空字符串 |

计时与复盘存放在个人数据文件中；计时记录可通过 `task_ref` 引用协作任务。不能把个人计时、复盘写入对方共享清单。任务的当前标签与计时记录的 `label_snapshot` 分别表示当前分类和历史快照，修改标签时须保留两者的语义。

### ⚠️ 数据契约铁律

1. **Schema 优先**：修改共享数据结构时，**必须先更新对应 Schema**（待办及学习记录为 `todo_data.schema.json`，协作源配置为 `collaborations.schema.json`），再同步修改两端代码。
2. **字段一致性**：Android 的 `Todo.kt`、`TodoData.kt`、`Learning.kt`、`Collaboration.kt` 与 Windows 的 `dateUtils.js`、`main.js`、`timeTracking.js` 中对应对象的序列化字段必须与 Schema 一致。
3. **新增字段必须有默认值**：为保持向后兼容，新增字段必须提供合理的默认值（如 `deleted` 默认 `false`）。
4. **不可删除字段**：已发布的字段不可删除，只能标记废弃（deprecated）。
5. **整文件操作保留扩展数据**：加载、迁移、保存、同步、备份与恢复个人数据时，必须保留提醒设置、计时和复盘。处理旧文件时补默认值，不得用仅含 `todos` 的对象覆盖已有完整数据。

---

## 5. 同步机制

### 5.1 同步模式

应用支持两种同步模式，由 `AppConfig.sync_mode` 决定：

| 模式 | 值 | 工作方式 |
|------|-----|---------|
| **本地文件夹同步** | `"local"` | 将 `todo_data.json` 存放在坚果云等同步盘的文件夹中，由同步盘软件负责文件同步 |
| **WebDAV 同步** | `"webdav"` | 通过 WebDAV 协议直接上传/下载 `todo_data.json`（默认坚果云 DAV 地址） |

### 5.2 冲突解决策略

按数据类别合并，不能用整文件或整条任务的简单覆盖替代全部规则：

| 数据类别 | 当前合并规则 |
|----------|-------------|
| **待办基础字段** | 按 `id` 合并，选择 `updated_at` 较新的版本；旧记录缺失该字段时使用 `created_at`（Windows 回退，Android 模型默认值）。有效时间相同时保留本地版本；仅一端存在的任务直接纳入。任务结果按 `created_at` 降序排列 |
| **打卡记录 `completed_dates`** | 在基础字段之外单独按日期前缀归并：同一天双方都有记录时保留较长的记录（等长取本地）；单边的纯日期记录保留，单边带时间记录仅在其时间晚于另一端任务更新时间时保留。此规则同时处理补卡与销卡，不能简单取并集。随后重新计算周/月任务是否达到 `target_count` |
| **全局提醒设置** | 使用 `reminder_settings.updated_at` 选择整份设置；有独立有效时间戳的一端优先。双方都缺少有效时间戳的旧数据优先保留非空规则，否则回退到文件 `last_updated` 比较 |
| **计时记录** | `time_entries` 按记录 `id` 合并，选择更新时间较新的整条记录 |
| **每日复盘** | `daily_reviews` 按 `date` 合并，即使记录 ID 不同，同一天也只保留更新时间较新的整篇复盘；不逐字段拼接 |
| **协作源配置** | `collaborations.json` 的配置按 `id` 和 `updated_at` 合并，保留删除标记；独立于个人待办数据合并 |

计时与复盘在更新时间相同时优先保留 `deleted: true` 的记录；删除状态也相同时按规范化内容排序确定结果，保证交换合并方向及重复同步时结果稳定。这一规则不能直接套用到普通待办的同时间戳处理上。

**实现入口**：Windows 为 `src/main.js` 的 `mergeTodoData()`、`mergeReminderSettings()`、`resolveCheckinConflict()`、`mergeCollaborations()`，以及 `src/timeTracking.js` 的 `mergeLearningRecords()`；Android 为 `data/model/MergeUtils.kt`、`data/model/Learning.kt`，协作源配置合并在 `data/repository/TodoRepository.kt`。

### 5.3 删除记录的保留与清理

- 用户删除任务时先设置 `deleted = true` 并更新任务的 `updated_at`，使删除状态参与同步。
- 两端的 `purgeOldDeletedTodos()` 会清理删除超过 7 天的任务记录，按 `updated_at` 判断，缺失时回退到 `created_at`。实现分别位于 Windows `src/main.js` 和 Android `data/repository/TodoRepository.kt`，保留天数由各自的 `PURGE_DELETED_AFTER_DAYS` 定义。
- 该保留期针对待办记录，不应自动套用到计时、复盘或协作源配置。修改清理或合并逻辑时，应覆盖长期离线端重新同步、删除标记和时间戳异常等边界。
- 当前异常时间戳处理存在差异：Windows 会清除时间戳无法解析的已删除任务，Android 会保留。修改相关逻辑时须核对两端实现，不能假定所有清理边界已一致。

### 5.4 文件安全

Windows 端使用以下机制保证文件安全：
- **文件锁**（`fs2`）：读操作获取共享锁，写操作获取排他锁，最多重试 20 次（50ms 间隔）
- **原子写入**：先写 `.tmp` 文件，再 `rename` 到目标路径
- **自动备份**：每次写入前自动备份，保留最近 5 个备份

---

## 6. 开发规范

### 6.1 通用规范

- **语言**：代码注释和 commit message 使用中文
- **ID 生成**：所有新建的 Todo 和 Subtask 使用 UUID v4
- **日历日期与时间**：任务 `date` 保留 `YYYY-MM-DD`、`YYYY-Www` 或 `YYYY-MM` 等日历字符串，复盘 `date` 使用 `YYYY-MM-DD`；任务 `time` 等本地时刻使用 `HH:mm`。这些字段不转换为 UTC 时间戳。
- **时间戳**：`created_at`、`updated_at`、`completed_at`、计时的 `started_at` / `ended_at` 等时间点使用带时区的完整 ISO 8601 字符串（如 `2026-09-12T02:00:00.000Z` 或 `2026-09-12T10:00:00+08:00`）；允许为空的字段按 Schema 保留 `null`。
- **本地日期判定与旧格式兼容**：判断“今天”及按日统计时，先把时间戳转换到设备本地时区，再提取日历日期；不要直接截取 UTC 字符串的日期部分。`completed_dates` 中的旧版纯日期记录按其日历日期处理，继续兼容带时间的记录，不得为统一格式而丢弃已有记录或伪造具体时刻。
- **软删除**：用户删除操作设置 `deleted = true`；待办记录超过 7 天的保留期后由统一清理函数物理清除，规则及实现差异见 §5.3
- **更新时间戳**：任何修改操作必须同时更新 `updated_at` 字段

### 6.2 Windows 端规范

- 前端为**纯 Vanilla JS**（ES Module），不使用任何框架（React/Vue 等），不要引入框架
- 前端直接操作 DOM，不使用虚拟 DOM
- 通过 `window.__TAURI__.core.invoke()` 调用 Rust 后端命令
- 通过 `window.__TAURI__.event.listen()` 监听后端事件
- 窗口无边框（`decorations: false`）、透明（`transparent: true`）、不显示在任务栏（`skipTaskbar: true`）
- CSS 使用 Vanilla CSS，不使用预处理器

### 6.3 Android 端规范

- 使用 Jetpack Compose 构建 UI，遵循 Material 3 设计规范
- 架构遵循 MVVM：`Model` → `Repository` → `ViewModel` → `Composable`
- 数据序列化使用 `kotlinx.serialization`，**不使用 Gson**
- Gradle 仓库配置了阿里云镜像，不要移除

### 6.4 修改代码前的检查清单

在进行任何代码修改前，请确认：

- [ ] 是否涉及共享数据结构变更？→ 先更新对应的 `todo_data.schema.json` 或 `collaborations.schema.json`
- [ ] 是否需要两端同步修改？→ 列出两端需要修改的文件
- [ ] 是否影响同步/合并逻辑？→ 检查 §5.2 对应数据类别的两端实现
- [ ] 新增字段是否有默认值？→ 确保向后兼容
- [ ] 是否更新了 `updated_at`？→ 任何数据修改都必须更新此字段

---

## 7. 关键文件速查

| 关注点 | Windows 文件 | Android 文件 |
|--------|-------------|-------------|
| **待办模型与创建** | `src/dateUtils.js` → `createTodo()`；`src/main.js` → `appState.todoData` | `data/model/Todo.kt`、`data/model/TodoData.kt` |
| **数据持久化** | `src-tauri/src/todo_store.rs` | `data/repository/TodoRepository.kt` |
| **待办迁移与合并** | `src/main.js` → `migrateAndNormalize()`、`mergeTodoData()` | `data/model/MergeUtils.kt`（由 Repository 调用） |
| **WebDAV** | `src-tauri/src/todo_store.rs` → `sync_to_cloud()` / `fetch_from_cloud()` | `data/WebDavClient.kt` |
| **日期、语法解析与分组** | `src/dateUtils.js` | `data/model/TodoDateUtils.kt`、`TodoDateParser.kt`、`TodoGrouper.kt` |
| **配置管理** | `src-tauri/src/todo_store.rs` → `AppConfig` | `data/ConfigManager.kt` |
| **UI 入口** | `src/index.html` + `src/main.js` | `MainActivity.kt` |
| **待办列表与状态管理** | `src/main.js` | `ui/view/ListView.kt`、`ui/viewmodel/TodoViewModel.kt` |
| **协作清单** | `src/main.js` → `mergeCollaborations()`；`src-tauri/src/todo_store.rs` | `data/model/Collaboration.kt`、`data/repository/TodoRepository.kt` |
| **提醒** | `src/reminderRuleUtils.js`、`src/main.js` | `data/model/ReminderRuleEvaluator.kt`、`notification/` |
| **计时、标签与复盘** | `src/timeTracking.js`、`reviewUtils.js`、`learningView.js` | `data/model/Learning.kt`、`ui/view/LearningView.kt`、`LearningLabelPicker.kt` |
| **统计与时间线** | `src/main.js`、`statsTimeline.js`、`statsTimelineView.js`、`statsVerticalView.js` | `data/model/StatsUtils.kt`、`StatsTimeline.kt`；`ui/view/StatsView.kt`、`StatsTimelineLayer.kt`、`StatsVerticalTimeline.kt` |
| **钟面动画** | `src/clockAnimation.js` | `ui/view/ClockEntryAnimation.kt` |
| **桌面小组件** | N/A | `widget/TodoWidget.kt` |
| **系统托盘/快捷键** | `src-tauri/src/lib.rs` | N/A |

Windows 路径相对于 `windows/`；Android 路径相对于 `android/app/src/main/java/com/todo/app/`，同一单元格内省略重复目录的文件位于该目录下。

---

## 8. 已知约束与注意事项

1. **Windows 前端 `main.js` 体积较大**，集中处理状态、DOM 交互与待办同步；日期、计时复盘、提醒计算和时间线已有独立模块。修改前先查上面的文件索引，避免重复实现或引入全局状态冲突。
2. **文件监听器**（`watch_file`）在 Windows 端监听 `todo_data.json` 所在目录，修改文件路径相关逻辑时需同步调整。
3. **WebDAV 默认地址**为坚果云（`https://dav.jianguoyun.com/dav/`），路径中的中文会被 URL 编码。
4. **备份文件**命名格式为 `todo_data_{unix_timestamp}.json`，存放在 Tauri 的 `app_data_dir/backups/` 目录下。
5. **Android 使用阿里云 Maven 镜像**，在国内网络环境下构建更快，不要移除。

---

## 9. 自动化测试

根据本次改动选择检查，涉及多类改动时合并执行相应检查：

| 改动范围 | 必须执行的检查 | 执行目录 |
|----------|----------------|----------|
| **仅文档** | 核对内容、相关路径/链接、示例与格式；无需运行应用测试 | 项目根目录 |
| **仅 Windows 前端代码或相关配置** | `npm run check` 和 `npm run test`，两项均须通过 | `windows/` |
| **Windows Rust 后端代码或 Cargo 配置/依赖** | `cargo check`；有相关 Rust 测试时运行对应测试。npm 检查不能替代 Rust 编译检查 | `windows/src-tauri/` |
| **仅 Android 代码或相关配置** | `.\gradlew.bat lintDebug testDebugUnitTest`；本机 JDK 设置见 §12 | `android/` |
| **共享数据契约、同步/迁移或跨平台业务逻辑** | 运行 Windows 前端与 Android 两端门禁；可通过 `./run-tests.ps1` 一次执行。涉及 Rust 时另加上述 Rust 检查 | 一键脚本在项目根目录；分别执行时使用各端目录 |

单端改动无需运行未受影响平台的检查。下面的测试清单用于定位覆盖范围，针对工具函数、合并迁移与数据模型的补测试要求仍适用。

### 9.1 测试架构

Windows 构建门禁与测试位于 `windows/tests/`；Android 测试见 §9.3。

| 层级 | 文件 | 作用 | 命令 |
|------|------|------|------|
| **构建门禁** | `check-build.mjs` | JS 语法、命名导入/导出、import 位置、HTML 脚本引用、Schema 文件结构、关键函数作用域 | `npm run check` |
| **日期与任务工具** | `test-dateUtils.mjs` | 日期、任务创建、输入解析与分组 | `npm run test:unit` |
| **数据逻辑** | `test-dataLogic.mjs` | 待办迁移与合并、提醒设置、学习数据保存与协作写入隔离、Schema 字段检查 | `npm run test:data` |
| **计时与标签** | `test-timeTracking.mjs` | 跨日计时、重叠处理、任务来源、学习记录合并 | `npm run test` |
| **复盘导出** | `test-reviewUtils.mjs` | 复盘预览、Markdown 导出与统计选项 | `npm run test` |
| **时间线** | `test-statsTimeline.mjs` | 标签归类、完成记录、计时圆弧与日期边界 | `npm run test` |
| **提醒规则** | `test-reminderRuleUtils.mjs` | 完成判定、规则范围与本地日期边界 | `npm run test` |
| **钟面动画** | `test-clockAnimation.mjs` | 动画时序、快速切换与延迟清理 | `npm run test` |

`npm run test` 运行全部 `test-*.mjs`；`test:unit` 和 `test:data` 只运行各自指定文件。构建门禁的 Schema 检查不等同于完整 JSON Schema 实例校验。

### 9.2 Windows 端测试要求

1. **按改动范围运行检查**：修改 Windows 前端后，在 `windows/` 执行 `npm run check` 和 `npm run test`；修改 Rust 后端时，在 `windows/src-tauri/` 执行 `cargo check` 并运行已有的相关测试。涉及两者时均须通过。
2. **新增工具函数必须补测试**：在 `dateUtils.js` 中新增的每个 `export function` 都必须在 `test-dateUtils.mjs` 中有对应的测试用例。
3. **修改合并/迁移逻辑必须补测试**：修改 `mergeTodoData()` 或 `migrateAndNormalize()` 后，必须在 `test-dataLogic.mjs` 中添加对应的边界测试。
4. **修改 Schema 必须验证**：更新 `todo_data.schema.json` 后，必须确保 `createTodo()` 的输出仍然包含 Schema 中 `todos.items.properties` 定义的所有属性。

### 9.3 Android 端测试架构

测试位于 `android/app/src/test/java/com/todo/app/`：日期、统计、提醒与学习记录测试在 `data/model/`，合并与序列化测试在 `data/repository/`，钟面动画测试在 `ui/view/`。

| 层级 | 文件 | 作用 | 命令 |
|------|------|------|------|
| **构建门禁** | 内置 Lint | 编译检查 + API 兼容性 + 代码规范 | `./gradlew lintDebug` |
| **单元测试** | `TodoDateUtilsTest.kt`, `StatsUtilsTest.kt` | 日期工具 + 统计计算纯函数 | `./gradlew testDebugUnitTest` |
| **数据逻辑** | `MergeLogicTest.kt`, `SerializationTest.kt` | 合并策略 + 序列化兼容性 | `./gradlew testDebugUnitTest` |
| **计时与复盘** | `LearningTest.kt` | 跨日计时、标签、学习记录合并、兼容性与导出 | `./gradlew testDebugUnitTest` |
| **时间线** | `StatsTimelineTest.kt` | 完成记录、计时圆弧、标签与日期边界 | `./gradlew testDebugUnitTest` |
| **提醒规则** | `ReminderRuleEvaluatorTest.kt` | 提醒条件、任务范围与完成判定 | `./gradlew testDebugUnitTest` |
| **钟面动画** | `ClockEntryAnimationTest.kt` | 出场顺序、午夜边界与圆弧显示区间 | `./gradlew testDebugUnitTest` |

### 9.4 Android 端测试铁律

1. **修改 Android 代码后必须运行测试**：在 `android/` 执行 `.\gradlew.bat lintDebug testDebugUnitTest`，全部通过后才可提交；仅修改文档时按本节开头的范围表核验。
2. **修改 TodoDateUtils.kt / StatsUtils.kt 必须补测试**：新增或修改的纯函数必须在对应 Test 文件中有覆盖。
3. **修改合并/迁移逻辑必须补测试**：修改 `mergeTodoData()` 或 `migrateTodo()` 后，必须在 `MergeLogicTest.kt` 中验证边界情况。
4. **修改数据模型必须验证序列化**：更新 `Todo.kt` / `TodoData.kt` 后，必须在 `SerializationTest.kt` 中确认旧 JSON 仍可正确解析。

### 9.5 全平台一键测试脚本 (★ 推荐)

为了避免在测试时重复审核多个平台的命令，在项目根目录下提供了一个 PowerShell 脚本：[run-tests.ps1](file:///d:/aaa/project/to-do%20list/run-tests.ps1)。

该脚本按顺序运行 Windows 前端和 Android 端的测试门禁；`JAVA_HOME` 未设置时，使用下文记录的本机 JDK 路径。脚本不执行 Rust 编译检查，涉及 Rust 的改动需另行运行 `cargo check`。

**执行方式**：
```powershell
./run-tests.ps1
```
*(如果遇到权限受限，可运行 `PowerShell -ExecutionPolicy Bypass -File .\run-tests.ps1`)*

---

## 10. ⚠️ ES Module 铁律（血泪教训）

以下规则针对 Windows 前端（纯 Vanilla JS + ES Module）的开发，**绝对不可违反**：

1. **本项目要求 `import` 声明集中在文件开头**：放在 `const`、`let`、`var`、函数声明或调用等代码之前，由 `windows/tests/check-build.mjs` 强制检查。这是项目约定；ES Module 允许静态 `import` 出现在模块顶层的其他位置，位置靠后本身不会导致脚本崩溃。静态 `import` 仍须位于模块顶层，不能放入函数或条件块中。
2. **禁止导入不存在的名称**：`import { foo } from './bar.js'` 中的 `foo` 必须在 `bar.js` 中有对应的 `export`。ES 模块在链接阶段会检查所有命名导出，缺失的导入将导致致命错误。
3. **禁止重复声明 export**：同一个文件中不可出现两个同名的 `export function`（如重复的 `getLastWeekString`），否则触发 `SyntaxError`。
4. **提取/移动函数时必须同步清理**：将函数从 `main.js` 提取到 `dateUtils.js` 时，必须同时更新 `main.js` 的 import 列表，删除已不存在的引用，添加新的引用。
5. **保护 `index.html` 核心入口标签**：`index.html` 末尾必须保留 `<script type="module" src="/main.js"></script>`。编辑 HTML 时如意外清除了该标签，将导致前端代码完全不会加载且没有任何控制台报错（静默失效，表现为点击按钮无任何反应）。

---

## 11. ⚠️ 版本更新修改指南

当发布新版本时（例如从 `v1.0.2` 升级到 `v1.0.3`），**必须确保双端（Windows 和 Android）的版本号及相关配置文件同步更新**，否则会导致版本显示不一致或自动更新功能失效。

发布时使用同一次完整构建生成的安装包和可执行文件，避免混用旧产物。

### 11.1 Windows 端版本修改文件
必须同步修改以下 3 个文件中的版本号：
1. **[package.json](file:///d:/aaa/project/to-do%20list/windows/package.json)**：
   * 修改 `"version": "x.y.z"`
2. **[Cargo.toml](file:///d:/aaa/project/to-do%20list/windows/src-tauri/Cargo.toml)**：
   * 修改 `[package]` 下的 `version = "x.y.z"`
3. **[tauri.conf.json](file:///d:/aaa/project/to-do%20list/windows/src-tauri/tauri.conf.json)**：
   * 修改 `"version": "x.y.z"`

### 11.2 Android 端版本修改文件
必须修改以下文件以更新 APP 内部版本及校验：
1. **[build.gradle.kts](file:///d:/aaa/project/to-do%20list/android/app/build.gradle.kts)**：
   * 修改 `versionName = "x.y.z"`（用于界面显示和自动更新的版本对比）
   * 增加 `versionCode = N`（内部版本代码，必须为每次发布递增的整数）

---

## 12. 本机 Android 编译环境与命令

本机使用 Android Studio 自带的 JDK，路径为 `D:\android studio\jbr`。执行 Android 构建或测试前，在当前终端设置 `JAVA_HOME`，并在项目的 `android/` 目录运行 Gradle。

**调用脚本示例（PowerShell）：**

```powershell
$env:JAVA_HOME = "D:\android studio\jbr"
.\gradlew.bat lintDebug testDebugUnitTest
```

执行其他 Gradle 任务时，保留 `JAVA_HOME` 设置，替换最后一行的任务名称即可。
