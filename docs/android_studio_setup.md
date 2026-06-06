# Android Studio 安装与 APK 构建指南

本指南旨在帮助您在没有 Android 经验的情况下，安装 Android 开发环境并编译生成我们待办软件的手机端 APK。

---

## 💾 系统与存储空间要求

由于 Android SDK 和构建缓存比较占用空间，建议您在安装前确认系统盘（通常是 C 盘，或您选择的安装盘）有足够的剩余空间：

* **最少可用空间**: **15 GB** (仅包含 IDE、基础 SDK，不使用手机模拟器，直接用真机测试)
* **推荐可用空间**: **30 GB 或以上** (如果需要下载多个版本的 SDK、模拟器镜像以及存放较多构建缓存)
* **硬件建议**: 
  * 强烈建议安装在 **SSD (固态硬盘)** 上，机械硬盘编译速度会非常慢。
  * 内存 (RAM) 建议 **8 GB** 起步，推荐 **16 GB** 或以上。

---

## 🛠️ 第一步：下载并安装 Android Studio

1. **下载安装包**：
   * 访问 Android Studio 官方中文社区或官网：[Android Studio 官网](https://developer.android.google.cn/studio?hl=zh-cn)
   * 点击 **"Download Android Studio"** 按钮，下载 Windows 版本的安装包（通常为 `.exe` 格式，大小约 1.1 GB）。

2. **开始安装**：
   * 双击运行下载的安装包。
   * **组件选择**：在 "Choose Components" 界面中：
     * `Android Studio` (必选)
     * `Android Virtual Device` (模拟器，可选。如果您直接用自己的华为手机测试，可以取消勾选以节省约 2-3 GB 空间)。
   * **选择路径（推荐安装在 D 盘）**：在 "Configuration Settings" 页面，将默认的安装路径 `C:\Program Files\Android\Android Studio` 修改为 **`D:\Android\Android Studio`**。
   * 点击 Next 并完成安装。

3. **首次启动设置向导（将最占空间的 SDK 设在 D 盘）**：
   * 启动 Android Studio。
   * 提示导入设置时，选择 "Do not import settings"。
   * 在 "Verify Settings" 页面，选择 **Standard**（标准）安装。
   * **更改 SDK 路径**：在接下来的 "SDK Components Setup" 页面，系统会指定 SDK 下载路径。默认位于 C 盘，请点击右侧按钮将其修改为 **`D:\Android\Sdk`**。
   * 之后点击 **Next**，接受协议 (Accept License)，然后点击 **Finish** 开始下载 SDK（此过程需要联网，下载完成后会存放在您指定的 D 盘路径中）。

---

## 📂 第二步：导入我们的待办项目

1. 下载/同步好代码后，在 Android Studio 的欢迎界面点击 **Open**。
2. 找到您电脑上的项目路径，选择 **`android`** 文件夹（即包含 `build.gradle.kts` 的那个文件夹，切记不要选错为最外层的 `to-do list`）。
3. 点击 **OK** 导入项目。
4. **等待 Gradle 同步**：
   * 首次打开时，Android Studio 右下角会显示 "Gradle Syncing..." 并开始下载项目依赖的构建工具（包括 Gradle 本身和各种库）。
   * 首次同步可能需要 **5 - 10 分钟**，取决于您的网络速度。请静待其完成，直到控制台不再报错且目录树加载完毕。

---

## 📦 第三步：构建（编译）APK 安装包

当项目同步成功且无报错后，您可以直接编译出 APK 文件：

1. 在顶部菜单栏中，点击 **`Build`** -> **`Build Bundle(s) / APK(s)`** -> **`Build APK(s)`**。
2. Android Studio 将开始编译项目。
3. 编译完成后，右下角会弹出一个提示框，点击其中的 **`locate`** 链接，即可直接打开 APK 所在的文件夹。
4. 默认生成的 APK 路径位于：
   `android/app/build/outputs/apk/debug/app-debug.apk`

---

## 📱 第四步：在华为手机上安装与设置

1. **传输文件**：将编译好的 `app-debug.apk` 通过微信、QQ 或 USB 数据线发送到您的华为手机上。
2. **允许安装**：
   * 在华为手机上点击该 APK 进行安装。
   * 系统可能会提示 "未知来源应用" 或 "纯净模式拦截"。
   * 请选择 **"仍然安装"**（或临时在设置中关闭纯净模式：**设置 -> 系统和更新 -> 纯净模式 -> 关闭**）。
3. **后台管控优化（非常重要）**：
   * 为了防止桌面小部件（Widget）因系统杀后台而无法刷新，请务必进行以下设置：
     1. 进入手机 **设置 -> 应用和服务 -> 应用启动管理**。
     2. 找到我们的待办 App，将 "自动管理" 关闭，在弹出的手动管理弹窗中，勾选：**允许自启动**、**允许关联启动**、**允许后台活动**。
     3. 进入手机 **设置 -> 电池**，确保该应用未被纳入极度省电的清理名单。
