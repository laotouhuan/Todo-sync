# AGENTS.md — AI 编码助手上下文指南

> 本文件为 AI 编码助手提供项目上下文，帮助快速理解项目结构、技术栈和核心设计决策。
> **人类开发者同样可以参考此文件快速上手项目。**

---

## 1. 项目概述

**Todo-sync** 是一个跨平台待办事项应用，支持 **Windows 桌面端** 和 **Android 移动端**，通过共享 JSON 数据文件实现双端数据同步。

### 核心能力

- 待办事项的增删改查（CRUD）
- 子任务（Subtasks）
- 循环任务（Recurring：daily / weekly / monthly）
- 软删除（Soft-delete，`deleted` 标记）
- 日期/时间/排序
- 统计视图（按日/周/月）
- 数据备份与恢复
- 云同步（文件夹同步 + WebDAV）

---

## 2. 项目结构

```
to-do list/
├── AGENTS.md                  # 本文件
├── todo_data.schema.json      # ★ 数据契约 — 两端共享的 JSON Schema
├── android/                   # Android 端（Kotlin + Jetpack Compose）
│   └── app/src/main/java/com/todo/app/
│       ├── MainActivity.kt
│       ├── TodoApplication.kt
│       ├── WidgetAddActivity.kt
│       ├── data/
│       │   ├── model/         # 数据模型：Todo.kt, TodoData.kt, TodoDateUtils.kt
│       │   ├── repository/    # 数据仓库：TodoRepository.kt
│       │   ├── ConfigManager.kt
│       │   └── WebDavClient.kt
│       ├── ui/
│       │   ├── view/          # UI 组件：ListView, EditTodoDialog, SettingsView, StatsView
│       │   ├── theme/         # Material 主题
│       │   ├── screen/        # （预留）
│       │   └── viewmodel/     # （预留，ViewModel 可能在上层）
│       └── widget/            # 桌面小组件：TodoWidget.kt, TodoWidgetProvider.kt
└── windows/                   # Windows 端（Tauri 2）
    ├── src/                   # 前端（纯 HTML/CSS/JS，无框架）
    │   ├── index.html
    │   ├── main.js            # 核心业务逻辑（~1275 行）
    │   ├── dateUtils.js       # 日期工具函数
    │   ├── styles.css         # 样式
    │   └── Sortable.min.js    # 拖拽排序库
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

两端共享同一个 JSON 数据文件 `todo_data.json`，其结构由 `todo_data.schema.json` 定义。

### 数据结构摘要

```jsonc
{
  "version": 1,                    // 数据版本号（整数）
  "last_updated": "ISO 8601",     // 最后更新时间
  "todos": [
    {
      "id": "UUID",               // 唯一标识（UUID v4）
      "content": "string",        // 待办内容（必填）
      "date": "string | null",    // 截止日期
      "time": "string | null",    // 截止时间
      "completed": false,         // 是否完成（必填）
      "completed_at": "ISO 8601 | null",  // 完成时间
      "created_at": "ISO 8601",   // 创建时间（必填）
      "updated_at": "ISO 8601",   // ★ 冲突解决依据
      "order": 0.0,               // 排序权重（数字）
      "deleted": false,           // 软删除标记
      "recurring": "none",        // 循环类型：none | daily | weekly | monthly
      "subtasks": [               // 子任务列表
        { "id": "UUID", "content": "string", "completed": false }
      ]
    }
  ]
}
```

### ⚠️ 数据契约铁律

1. **Schema 优先**：任何对数据结构的修改，**必须先更新 `todo_data.schema.json`**，再同步修改两端代码。
2. **字段一致性**：Android 的 `Todo.kt` / `TodoData.kt` 与 Windows 的 `main.js` 中的对象结构必须与 Schema 严格一致。
3. **新增字段必须有默认值**：为保持向后兼容，新增字段必须提供合理的默认值（如 `deleted` 默认 `false`）。
4. **不可删除字段**：已发布的字段不可删除，只能标记废弃（deprecated）。

---

## 5. 同步机制

### 5.1 同步模式

应用支持两种同步模式，由 `AppConfig.sync_mode` 决定：

| 模式 | 值 | 工作方式 |
|------|-----|---------|
| **本地文件夹同步** | `"local"` | 将 `todo_data.json` 存放在坚果云等同步盘的文件夹中，由同步盘软件负责文件同步 |
| **WebDAV 同步** | `"webdav"` | 通过 WebDAV 协议直接上传/下载 `todo_data.json`（默认坚果云 DAV 地址） |

### 5.2 冲突解决策略

```
合并策略：以 updated_at 时间戳为准，取更新的版本（Last-Write-Wins per item）
```

- 相同 `id` 的待办事项：比较 `updated_at`（回退到 `created_at`），取时间更新的版本
- 仅存在于一端的待办事项：直接合并到结果集
- 合并后按 `created_at` 降序排列
- **核心实现**：Windows 端 `main.js` 中的 `mergeTodoData()` 函数

### 5.3 文件安全

Windows 端使用以下机制保证文件安全：
- **文件锁**（`fs2`）：读操作获取共享锁，写操作获取排他锁，最多重试 20 次（50ms 间隔）
- **原子写入**：先写 `.tmp` 文件，再 `rename` 到目标路径
- **自动备份**：每次写入前自动备份，保留最近 5 个备份

---

## 6. 开发规范

### 6.1 通用规范

- **语言**：代码注释和 commit message 使用中文
- **ID 生成**：所有新建的 Todo 和 Subtask 使用 UUID v4
- **时间格式**：统一使用 ISO 8601 格式（`new Date().toISOString()` / Kotlin 等效方式）
- **软删除**：删除操作设置 `deleted = true`，不物理删除记录
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

- [ ] 是否涉及数据结构变更？→ 先更新 `todo_data.schema.json`
- [ ] 是否需要两端同步修改？→ 列出两端需要修改的文件
- [ ] 是否影响同步/合并逻辑？→ 检查 `mergeTodoData()` 和 Android 端对应逻辑
- [ ] 新增字段是否有默认值？→ 确保向后兼容
- [ ] 是否更新了 `updated_at`？→ 任何数据修改都必须更新此字段

---

## 7. 关键文件速查

| 关注点 | Windows 文件 | Android 文件 |
|--------|-------------|-------------|
| **数据模型** | `main.js` 中的 `todoData` 对象 | `data/model/Todo.kt`, `TodoData.kt` |
| **数据持久化** | `src-tauri/src/todo_store.rs` | `data/repository/TodoRepository.kt` |
| **同步/合并** | `main.js` → `mergeTodoData()` | `TodoRepository.kt` 中对应逻辑 |
| **WebDAV** | `todo_store.rs` → `sync_to_cloud()` / `fetch_from_cloud()` | `data/WebDavClient.kt` |
| **日期工具** | `src/dateUtils.js` | `data/model/TodoDateUtils.kt` |
| **配置管理** | `todo_store.rs` → `AppConfig` | `data/ConfigManager.kt` |
| **UI 入口** | `src/index.html` + `src/main.js` | `MainActivity.kt` |
| **桌面小组件** | N/A | `widget/TodoWidget.kt` |
| **系统托盘/快捷键** | `src-tauri/src/lib.rs` | N/A |

---

## 8. 已知约束与注意事项

1. **Windows 前端 `main.js` 体积较大**（~1275 行），包含了状态管理、DOM 操作、同步逻辑等所有功能，修改时注意不要引入全局状态冲突。
2. **文件监听器**（`watch_file`）在 Windows 端监听 `todo_data.json` 所在目录，修改文件路径相关逻辑时需同步调整。
3. **WebDAV 默认地址**为坚果云（`https://dav.jianguoyun.com/dav/`），路径中的中文会被 URL 编码。
4. **备份文件**命名格式为 `todo_data_{unix_timestamp}.json`，存放在 Tauri 的 `app_data_dir/backups/` 目录下。
5. **Android 使用阿里云 Maven 镜像**，在国内网络环境下构建更快，不要移除。
