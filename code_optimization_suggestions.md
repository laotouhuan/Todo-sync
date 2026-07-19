# Todo-sync 核心代码优化与简化建议报告

本项目由 **Windows 端 (Tauri + Vanilla JS)** 和 **Android 端 (Kotlin + Compose)** 双端构成，数据通过共享 JSON 文件同步。我们使用 `simplify` 技能扫描了双端的核心代码，旨在**不改变现有功能**的前提下，降低复杂度、提升可读性、减少嵌套，并融入各自语言的惯用法（Idiomatic Code）。

以下为针对双端核心代码的优化建议：

---

## 一、 Windows 端 (JavaScript & Rust)

### 1. `windows/src/dateUtils.js`

#### 优化函数：`calcTaskAgeDays`
* **问题陈述**：
  在转换 `new Date(...)` 时，使用了多余的 `try...catch` 块。在 JavaScript 中，传入非法字符串给 `new Date()` 并不会抛出异常，而是会返回一个 `Invalid Date` 对象，其 `getTime()` 值为 `NaN`。因此，`try...catch` 是多余的，增加了嵌套和不必要的运行时开销。
* **优化方案**：
  ```javascript
  export function calcTaskAgeDays(createdAt, now = new Date()) {
      if (!createdAt) return -1;
      const createdMs = new Date(createdAt).getTime();
      const nowMs = new Date(now).getTime();
      
      if (isNaN(createdMs) || isNaN(nowMs)) return -1;
      
      const diff = nowMs - createdMs;
      return diff < 0 ? 0 : Math.floor(diff / 86400000);
  }
  ```
* **优化合理性**：
  移除了无用的异常捕获块，降低了代码嵌套深度，同时通过 `isNaN` 准确检测非法日期，使逻辑更加清晰。

---

### 2. `windows/src/main.js`

#### 优化函数：`mergeCollaborations`
* **问题陈述**：
  在合并协作列表时，函数获取了所有 ID 的 `Set` 并遍历，但在每次循环中，都使用 `Array.prototype.find()` 对 `localList` and `cloudList` 进行查找。由于 `.find()` 的时间复杂度是 $O(N)$，导致整个合并操作的复杂度达到了 $O(N^2)$。当数据量增加时，可能造成明显的 UI 卡顿。
* **优化方案**：
  ```javascript
  function mergeCollaborations(local, cloud) {
      let localData = local || { version: 1, last_updated: "", collaborations: [] };
      let cloudData = cloud || { version: 1, last_updated: "", collaborations: [] };
      
      // 提前转换为 Map 以便实现 O(1) 查找
      let localMap = new Map((localData.collaborations || []).map(c => [c.id, c]));
      let cloudMap = new Map((cloudData.collaborations || []).map(c => [c.id, c]));
      
      let mergedList = [];
      let allIds = new Set([...localMap.keys(), ...cloudMap.keys()]);
      let changed = false;
      
      for (let id of allIds) {
          let localItem = localMap.get(id);
          let cloudItem = cloudMap.get(id);
          
          if (localItem && cloudItem) {
              let localTime = new Date(localItem.updated_at || 0).getTime();
              let cloudTime = new Date(cloudItem.updated_at || 0).getTime();
              
              if (cloudTime > localTime) {
                  mergedList.push(cloudItem);
                  changed = true;
              } else {
                  mergedList.push(localItem);
                  if (localTime > cloudTime) changed = true;
              }
          } else {
              // 只存在于一侧时，直接推入
              mergedList.push(localItem || cloudItem);
              changed = true;
          }
      }
      
      return {
          data: {
              version: 1,
              last_updated: changed ? new Date().toISOString() : (localData.last_updated || cloudData.last_updated || new Date().toISOString()),
              collaborations: mergedList
          },
          changed
      };
  }
  ```
* **优化合理性**：
  将查找复杂度从 $O(N)$ 降为 $O(1)$，使整个合并过程的时间复杂度缩减为 $O(N)$。此外，消除了繁琐的数组定位逻辑，提高了可读性。

#### 优化函数：`setSyncStatus`
* **问题陈述**：
  通过 `if-else` 条件分支手动判断状态，并添加对应的 CSS 类。实际上，状态的值与所需的 CSS 类名完全一致，手动分支存在冗余。
* **优化方案**：
  ```javascript
  function setSyncStatus(state) {
      if (statusEl) {
          statusEl.classList.remove('syncing', 'error');
          if (state !== SyncState.IDLE) {
              statusEl.classList.add(state);
          }
      }
  }
  ```
* **优化合理性**：
  避免了重复的条件分支。未来如果加入新的状态，只要其类名对应一致，无需修改此函数即可自动适配。

---

### 3. `windows/src-tauri/src/todo_store.rs`

#### 优化函数：`build_webdav_conn` 与 `build_collaborations_webdav_conn`
* **问题陈述**：
  两个函数在提取 WebDAV 凭据（URL、Username、Password）时存在大量重复的配置读取和回退逻辑。此外，对于 URL 的拼接（处理末尾 `/` 字符），手动逻辑略显冗余。
* **优化方案**：
  1. **提取公共配置获取逻辑**：
     ```rust
     fn get_webdav_credentials(config: &AppConfig) -> Result<(String, String, String), String> {
         if config.sync_mode.as_deref() != Some("webdav") {
             return Err("Not in WebDAV mode".to_string());
         }
         let url = config.webdav_url.as_deref().unwrap_or("https://dav.jianguoyun.com/dav/").to_string();
         let user = config.webdav_username.as_deref().unwrap_or("").to_string();
         let pass = config.webdav_password.as_deref().unwrap_or("").to_string();
         Ok((url, user, pass))
     }
     ```
  2. **简化 URL 拼接逻辑（使用 `trim_end_matches`）**：
     ```rust
     fn build_webdav_conn(config: &AppConfig) -> Result<WebDavConn, String> {
         let (url, user, pass) = get_webdav_credentials(config)?;
         let file_path = config.webdav_filepath.as_deref()
             .filter(|s| !s.is_empty())
             .unwrap_or("我的坚果云/to-do/todo_data.json");

         let encoded_path = file_path.split('/').map(|s| {
             if s.is_empty() { String::new() } else { urlencoding::encode(s).into_owned() }
         }).collect::<Vec<_>>().join("/");

         // 使用 Rust 内置方法去除尾部 '/' 并规范拼接
         let target = format!("{}/{}", url.trim_end_matches('/'), encoded_path);

         Ok(WebDavConn { user, pass, target })
     }
     ```
* **优化合理性**：
  遵循 DRY（Don't Repeat Yourself）原则，消除重复代码。采用 `trim_end_matches('/')` 可以安全且干净地处理 URL 尾部斜杠，不需要繁琐的 `ends_with` 条件判断。

---

### 4. `windows/src-tauri/src/lib.rs`

#### 优化：`watch_file` 监听线程循环
* **问题陈述**：
  在 `watch_file` 循环中，对 `rx.recv_timeout` 的结果匹配略显繁琐。对于不是当前文件路径的 `Ok` 结果以及其他的超时错误，可以使用模式匹配守卫（Match Guard）进行统一简化。
* **优化方案**：
  ```rust
  // 在 `watch_file` 线程的 loop 中：
  match rx.recv_timeout(Duration::from_millis(500)) {
      Ok(Event { paths, .. }) if paths.contains(&current_path) => {
          let _ = app_clone.emit("todo_data_changed", ());
      }
      Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
          log::error!("File watcher channel disconnected. Exiting watch loop.");
          break;
      }
      _ => {} // 优雅处理不匹配的路径事件、以及超时错误
  }
  ```
* **优化合理性**：
  使用 `if paths.contains...` 模式守卫，减少了内部嵌套深度，避免了“向右漂移”，让代码主体逻辑在视觉上更紧凑和易读。

---
---

## 二、 Android 端 (Kotlin & Jetpack Compose)

### 1. `android/app/src/main/java/com/todo/app/data/model/MergeUtils.kt`

#### 优化函数：`normalizeData` 与 `deduplicateDates`
* **问题陈述**：
  判断最大更新时间的对象时使用了复杂的 `try-catch` 和手动的列表长度判断。此外，在去重打卡日期时，先进行复杂的 `sortedWith` 排序然后取 `first()`，导致对整个列表进行了排序，增加了 $O(N \log N)$ 排序开销。
* **优化方案**：
  ```kotlin
  val uniqueTodos = migratedTodos.groupBy { it.id }
      .map { (_, list) ->
          list.maxByOrNull { 
              runCatching { OffsetDateTime.parse(it.updatedAt) }.getOrDefault(OffsetDateTime.MIN) 
          } ?: list.first()
      }

  private fun deduplicateDates(dates: List<String>): List<String> =
      dates.groupBy { it.substringBefore('T') }
          .map { (_, group) -> group.maxWithOrNull(compareBy<String> { it.length }.thenBy { it })!! }
          .sorted()
  ```
* **优化合理性**：
  1. 使用 Kotlin 标准库的 `runCatching` 和 `getOrDefault` 代替繁琐的 `try-catch` 块。
  2. 使用 `maxWithOrNull` 代替 `sortedWith(...).first()`，查找最大值的时间复杂度从 $O(N \log N)$ 降低到 $O(N)$，且无需在堆上创建排序所需的临时对象。

---

### 2. `android/app/src/main/java/com/todo/app/ui/view/ListView.kt`

#### 优化函数：`resolveTaskForSection`
* **问题陈述**：
  该函数在拖拽待办事项到不同分区时，需要计算目标日期、类型和重复配置。原实现中每个分支下都有深层的嵌套以及大量的局部变量声明与赋值，代码显得非常臃肿。
* **优化方案**：
  ```kotlin
  private fun resolveTaskForSection(section: String, todo: Todo, todayStr: String, thisWeekStr: String, thisMonthStr: String): SectionTaskResolution = when (section) {
      "today" -> SectionTaskResolution(
          date = todo.date?.takeUnless { isWeekDate(it) || isMonthDate(it) } ?: todayStr,
          taskType = TaskType.NORMAL,
          recurring = if (todo.taskType in listOf(TaskType.WEEKLY_CHECKIN, TaskType.MONTHLY_CHECKIN)) RecurringType.NONE else todo.recurring
      )
      "nodate" -> SectionTaskResolution(
          date = null,
          taskType = TaskType.NORMAL,
          recurring = if (todo.taskType in listOf(TaskType.WEEKLY_CHECKIN, TaskType.MONTHLY_CHECKIN)) RecurringType.NONE else todo.recurring
      )
      "week" -> SectionTaskResolution(
          date = todo.date?.takeIf { isWeekDate(it) } ?: thisWeekStr,
          taskType = TaskType.WEEKLY_CHECKIN,
          recurring = RecurringType.NONE
      )
      "month" -> SectionTaskResolution(
          date = todo.date?.takeIf { isMonthDate(it) } ?: thisMonthStr,
          taskType = TaskType.MONTHLY_CHECKIN,
          recurring = RecurringType.NONE
      )
      else -> SectionTaskResolution(todo.date, todo.taskType, todo.recurring)
  }
  ```
* **优化合理性**：
  采用单表达式函数（Single-Expression Function）风格，配合 `takeIf` / `takeUnless` 处理可空属性，消除了 30 多行临时变量和嵌套，使业务逻辑映射一目了然。

---

### 3. `android/app/src/main/java/com/todo/app/ui/viewmodel/TodoViewModel.kt`

#### 优化逻辑：`healthMetrics` 计算中的平均时长逻辑
* **问题陈述**：
  在统计分析中计算已完成待办事项的平均寿命时，代码手写了累加求和，最后再除以列表大小。
* **优化方案**：
  ```kotlin
  val currentAvgCompletedLife = if (completedTodos.isEmpty()) 0.0 else {
      completedTodos.map { 
          calcTaskAgeDays(it.createdAt, parseOffsetDateTimeSafe(it.completedAt, nowTime)) 
      }.average()
  }
  ```
* **优化合理性**：
  使用 Kotlin 标准库内置的 `average()` 扩展函数，自动处理类型转换和大小划分，使代码更具声明式特征（Declarative Style）。

---

### 4. `android/app/src/main/java/com/todo/app/data/model/TodoDateUtils.kt`

#### 优化函数：`getWeeklyCompletedCount` 与 `getMonthlyCompletedCount`
* **问题陈述**：
  逻辑中包含多层显式日期有效性判断与 `try-catch` 块。
* **优化方案**：
  ```kotlin
  fun Todo.getWeeklyCompletedCount(): Int {
      val dateStr = this.date?.takeIf { isWeekDate(it) } ?: return 0
      return this.completedDates.count { dStr ->
          runCatching { weekStringOf(LocalDate.parse(dStr)) == dateStr }.getOrDefault(false)
      }
  }

  fun Todo.getMonthlyCompletedCount(): Int {
      val dateStr = this.date?.takeIf { isMonthDate(it) } ?: return 0
      return this.completedDates.count { it.startsWith(dateStr) }
  }
  ```
* **优化合理性**：
  通过 `takeIf` 链式调用扁平化了边界守护，并使用 `runCatching` 替换显式 `try-catch`。此外，月份匹配直接使用 `startsWith(dateStr)` 极大简化了字符串格式比较。

---

### 5. `android/app/src/main/java/com/todo/app/data/repository/TodoRepository.kt`

#### 优化逻辑：`restoreFromBackup` 恢复备份
* **问题陈述**：
  方法中包含了复杂的嵌套 IO 操作与显式的 `try-catch`，导致需要多处手动编写 `return@withContext`。
* **优化方案**：
  ```kotlin
  suspend fun restoreFromBackup(filename: String): Boolean = mutex.withLock {
      withContext(Dispatchers.IO) {
          runCatching {
              val backupFile = File(File(context.filesDir, "backups"), filename)
              if (!backupFile.exists()) return@withContext false
              
              createLocalBackup() 
              val jsonString = backupFile.readText()
              _todoData.value = jsonFormat.decodeFromString(jsonString)
              atomicWriteJson(jsonString)
              
              initWebDavClient()
              webDavClient?.uploadFile(configManager.filePath, jsonString)
              com.todo.app.widget.refreshAllWidgets(context)
              true
          }.onFailure { e ->
              if (e is CancellationException) throw e // 保持协程取消的可传播性
              Log.e(TAG, "restoreFromBackup failed", e)
          }.getOrDefault(false)
      }
  }
  ```
* **优化合理性**：
  1. 通过反转 `exists()` 判断（Guard Clause），提前退出，减少主流程的缩进。
  2. 使用 `runCatching` + `getOrDefault` 捕获异常，并正确处理了协程的 `CancellationException`。整个方法返回值非常干净。
