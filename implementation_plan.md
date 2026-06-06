# 坚果云 (Nutstore) 多端同步桌面待办软件实施方案（v3）

本项目旨在开发一套轻量级、无服务器开销、高隐私安全的待办（To-Do）系统。支持在 Windows 桌面和华为手机桌面上以挂件（Widget）形式直接显示并操作，通过 **坚果云 (Nutstore) 及其 WebDAV 协议** 实现两端数据同步。

---

## 核心设计理念

1. **简洁至上 (KISS)**：拒绝复杂的后端服务器和多端通信协议，将多端同步退化为**"两端读写同一个坚果云云端/本地文件（todo_data.json）"**的问题。
2. **第一性原理剖析**：
   * **数据格式**：使用一个标准的 JSON 文件 `todo_data.json` 存储所有待办事项。
   * **同步机制**：
     * **Windows 端**：坚果云客户端在 Windows 上提供本地同步文件夹。软件直接读写该目录下的 `todo_data.json`，坚果云客户端自动完成秒级云端同步。
     * **手机端**：利用坚果云原生支持的 **WebDAV 协议**，App 内部通过标准 HTTP 网络请求直接读写云端的 JSON 文件。**无需安装坚果云手机客户端，也彻底避开了安卓系统的文件沙盒（SAF）授权与按需下载问题。**
   * **桌面小部件实现**：
     * Windows 端：**Tauri v2 (Rust + HTML/CSS/JS)**，无边框、透明、置底窗口，可交互操作。
     * 手机端：**Android 原生 (Kotlin)**，使用 `AppWidget` + `RemoteViews` 实现桌面小部件，触发 WebDAV 请求获取最新数据。

---

## 架构方案设计

### 1. 数据模型设计 (`todo_data.json`)

数据文件结构保持扁平与高效：

```json
{
  "version": 1,
  "last_updated": "2026-06-04T20:15:00+08:00",
  "todos": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "content": "撰写待办软件需求文档",
      "date": "2026-06-04",
      "time": null,
      "importance": 4,
      "urgency": 5,
      "completed": false,
      "created_at": "2026-06-04T10:00:00+08:00"
    }
  ]
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (UUID) | 唯一标识符，自动生成 |
| `content` | string | 待办事项内容 |
| `date` | string | 所属日期，格式 `YYYY-MM-DD` |
| `time` | string \| null | 具体时间，格式 `HH:mm`，为 null 表示仅按天划分 |
| `importance` | int (1-5) | 重要程度，用户自定义打分，1=最低，5=最高 |
| `urgency` | int (1-5) | 紧急程度，用户自定义打分，1=最低，5=最高 |
| `completed` | boolean | 是否已完成 |
| `created_at` | string (ISO 8601) | 创建时间 |

> **四象限视图**：界面上以 `importance >= 3` 和 `urgency >= 3` 为分界线，将待办自动归入四象限。这只是一种展示方式，底层数据始终保持独立打分的灵活性。

---

### 2. Windows 桌面挂件客户端

* **技术栈**：Tauri v2 + HTML/CSS/JS (Vanilla CSS)
* **界面风格**：现代化**半透明毛玻璃拟物风（Glassmorphism）**，圆角边框、柔和阴影

#### 桌面挂件核心技术点

* **窗口置底（贴在桌面上）**：通过 Rust 调用 `winapi` 库，将窗口 Z-Order 设为桌面层（位于桌面图标下方、壁纸上方），并设置 `set_skip_taskbar(true)` 使其不显示在任务栏中。
* **无边框与半透明**：Tauri 配置 `decorations: false`、`transparent: true`；CSS 使用 `backdrop-filter: blur(15px); background: rgba(255,255,255,0.12)`。
* **可交互操作**：挂件**不做鼠标穿透**，用户可直接在桌面面板上进行以下操作：
  * ✅ 勾选/取消完成待办
  * ➕ 快速添加新待办
  * 📝 点击编辑待办内容、重要度、紧急度
  * 🗑️ 删除待办
* **显示/隐藏切换**：
  * 全局快捷键 `Ctrl+Shift+T`：切换挂件的显示与隐藏
  * 系统托盘图标：右键菜单支持「显示/隐藏挂件」「设置」「退出」
  * 开机自启动：通过 Windows 注册表或 Tauri 内置的 autostart 插件实现
* **数据文件路径配置**：
  * 设置界面中提供"选择文件夹"按钮，用户指定坚果云同步目录下存放 `todo_data.json` 的文件夹
* **文件变更监听**：
  * 使用 Rust 的 `notify` crate 监听 `todo_data.json` 的文件系统变更事件
  * 当坚果云从云端同步下来新版本时，自动重新加载并刷新界面

---

### 3. 华为手机端 Android App（支持桌面挂件）

* **技术选型**：Android 原生 (Kotlin) + Jetpack Compose（现代声明式 UI）
* **预计包体积**：< 5MB

> [!IMPORTANT]
> **关于开发环境**：
> 1. 我会提供完整的、可直接编译的项目代码
> 2. 您只需安装 Android Studio，打开项目，点击 **Build > Build APK** 即可生成安装包
> 3. 我会编写详细的《Android Studio 安装与 APK 构建指南》文档

#### WebDAV 数据直连方案（架构优化核心）

* **直连云端**：App 不再依赖本地文件系统，而是在首次启动时，引导用户输入坚果云的 **WebDAV 地址、账号和第三方应用密码**。
* **网络读写**：App 内部封装简单的 HTTP 客户端，执行 GET 请求获取 JSON，执行 PUT 请求覆盖更新 JSON。完全规避了 Android SAF 权限地狱。

#### 桌面挂件 (AppWidget)

* `TodoWidgetProvider` 继承 `AppWidgetProvider`
* 挂件布局支持：
  * 上下滑动滚动待办列表（使用 `RemoteViewsService` + `RemoteViewsFactory`）
  * 直接在桌面点击复选框勾选完成
  * 点击待办项跳转到 App 内编辑
* 挂件刷新机制：
  * 定时刷新（每 30 分钟自动发起 WebDAV 请求刷新一次）
  * 用户在 App 内修改数据后立即触发挂件刷新

> [!WARNING]
> **华为手机后台管控问题**：华为手机有非常激进的后台管控，为了确保挂件能定时发起 WebDAV 网络请求刷新数据，需引导用户手动设置：
> 1. **设置 → 应用 → 待办 App → 省电模式 → 无限制**
> 2. **设置 → 应用 → 待办 App → 自动启动 → 开启**

---

## 项目目录结构

```
to-do list/
├── implementation_plan.md          # 架构方案文档
├── windows/                        # Windows 端 Tauri 项目
│   ├── src-tauri/                  # Rust 后端
│   │   ├── src/
│   │   │   ├── main.rs             # 入口、窗口置底、托盘、快捷键
│   │   │   ├── todo_store.rs       # JSON 文件读写
│   │   │   └── file_watcher.rs     # 本地同步文件变更监听
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   └── src/                        # 前端
│       ├── index.html
│       ├── index.css
│       └── index.js
├── android/                        # Android 端 Kotlin 项目
│   ├── app/
│   │   ├── src/main/
│   │   │   ├── java/.../
│   │   │   │   ├── MainActivity.kt
│   │   │   │   ├── WebDavClient.kt # WebDAV 网络请求客户端
│   │   │   │   ├── TodoRepository.kt
│   │   │   │   └── TodoWidgetProvider.kt
│   │   │   ├── res/
│   │   │   └── AndroidManifest.xml
│   │   └── build.gradle.kts
│   ├── build.gradle.kts
│   └── settings.gradle.kts
└── docs/
    └── android_studio_setup.md     # Android Studio 安装与构建指南
```

---

## 任务拆分与路线图

### 第一阶段：数据契约定义
1. `[x]` 确定 `todo_data.json` 的 JSON Schema（含 `importance`/`urgency` 独立字段）

### 第二阶段：Windows 桌面挂件开发（Tauri）
1. `[ ]` 搭建 Tauri v2 项目骨架，配置窗口透明无边框
2. `[ ]` 实现 Rust 侧窗口置底逻辑（winapi Z-Order 操控）
3. `[ ]` 实现系统托盘图标与右键菜单（显示/隐藏、设置、退出）
4. `[ ]` 实现全局快捷键 `Ctrl+Shift+T` 切换显示/隐藏
5. `[ ]` 实现设置面板：选择坚果云同步目录路径
6. `[ ]` 编写 Rust 侧文件读写接口（文件锁定 + 原子写入）
7. `[ ]` 实现文件变更监听（`notify` crate），同步后自动刷新
8. `[ ]` 设计毛玻璃拟物化前端界面，实现待办的增删改查、拖拽排序等

### 第三阶段：Android 手机端 App 开发
1. `[ ]` 编写《Android Studio 安装与 APK 构建指南》文档
2. `[ ]` 创建 Kotlin Android 项目（Jetpack Compose）
3. `[ ]` **实现 WebDAV 客户端，提供登录界面让用户配置坚果云账号/应用密码**
4. `[ ]` 开发手机端主界面（列表视图 + 四象限视图），实现云端增删改查
5. `[ ]` 实现桌面挂件 `TodoWidgetProvider` 及其刷新逻辑

### 第四阶段：双端同步测试与优化
1. `[ ]` 基于 `last_updated` 时间戳的合并策略处理
2. `[ ]` 双端数据实时互通全面测试
