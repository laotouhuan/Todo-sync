# Android 自动发布

工作流 `.github/workflows/release.yml` 支持推送 `v*` 标签或手动运行。
先构建并验证 Android Release APK，再构建 Windows；两端安装包与 latest.json 一起上传到同一个 Release。
Android 构建或签名检查失败时不会继续发布更新索引。

## 仓库 Actions Secrets

在仓库 Settings → Secrets and variables → Actions 中设置：

| Secret | 内容 |
| --- | --- |
| ANDROID_KEYSTORE_BASE64 | 原 Android 发布 keystore 文件的 Base64 内容 |
| KEYSTORE_PASSWORD | keystore 密码 |
| KEY_PASSWORD | 签名私钥密码 |
| KEY_ALIAS | keystore 中的签名别名（当前本地配置默认 key0） |

必须使用与已有安装包一致的签名，不能临时生成新 keystore 代替。缺少任何一项时工作流会明确失败，不回退到 Debug 签名。
Base64 只是编码，不能公开；不要将编码结果、密码或 keystore 放入代码、日志或发布附件。
工作流仅上传已签名 APK，并在构建结束后删除临时签名文件。
使用旧密钥维持升级兼容，并不消除该密钥此前暴露带来的风险；密钥更换应另行规划。

本地验证命令：设置 JAVA_HOME、KEYSTORE_PASSWORD、KEY_PASSWORD（必要时 KEY_ALIAS），在 android 目录运行 `./gradlew lintDebug testDebugUnitTest assembleRelease`。
配置 Secrets 后，提交并推送工作流，再从 Actions 中手动运行 **Publish Desktop and Android Release**。
Android 的 versionName 必须与 Windows tauri.conf.json 的 version 相同；标签触发时标签名必须为该版本的 v 前缀。
