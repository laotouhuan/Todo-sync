# 实际 Android 打卡纯函数探针

此工具逐字抽取 `MergeUtils.kt` 的 `mergeCompletedDates()`，加入独立 NDJSON 包装后编译运行，不重写打卡算法，不读取期望结果，不修改应用源码或业务规则。

从仓库根目录构建：

```powershell
./tools/record-sync-protocol-lab/checkin-probe/build.ps1
```

构建使用本机 JDK 和已缓存 Kotlin 2.0.21／serialization 1.7.3，产物位于忽略的 `build/`。`launch.json` 提供 `ProbeKt` 与 classpath；`source-manifest.json` 保存实际源文件和逐字抽取函数的 SHA-256。

stdin 每行：`{id,local_dates,cloud_dates,local_updated,cloud_updated}`。日期数组只含字符串，任务更新时间须可解析为 `OffsetDateTime`；stdout 回复 `{id,ok:true,dates}`，错误回复 `{id,ok:false}` 后继续处理。

它只验证该纯函数，不验证 Repository、整体合并、完成状态重算、Android 系统环境或真实传输。调用方解析任务更新时间的异常回退也不在此包装内；不得将探针通过描述为整个 Android 同步验收通过。
