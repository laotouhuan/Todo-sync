package com.todo.app.ui.view

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState

import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import com.todo.app.ui.viewmodel.TodoViewModel
import com.todo.app.utils.AppUpdater
import com.todo.app.utils.UpdateInfo
import com.todo.app.utils.UpdateResult
import kotlinx.coroutines.launch

import android.content.Context
import android.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import com.todo.app.data.model.ShareCodePayload
import com.todo.app.data.model.CollaborationSource
import com.todo.app.data.model.isOverdue
import java.util.UUID

@Composable
fun SettingsView(viewModel: TodoViewModel) {
    var serverUrl by remember { mutableStateOf(viewModel.configManager.webDavUrl) }
    var username by remember { mutableStateOf(viewModel.configManager.username) }
    var appPassword by remember { mutableStateOf(viewModel.configManager.appPassword) }
    var filePath by remember { mutableStateOf(viewModel.configManager.filePath) }
    var nickname by remember { mutableStateOf(viewModel.configManager.nickname) }
    val collaborations by viewModel.collaborations.collectAsState()

    var defaultDueDate by remember { mutableStateOf(viewModel.configManager.defaultDueDate) }
    var defaultInsertion by remember { mutableStateOf(viewModel.configManager.defaultInsertion) }

    var shareCodeOutput by remember { mutableStateOf("") }
    var shareKeyOutput by remember { mutableStateOf("") }
    var shareExpireDays by remember { mutableStateOf(0) } // 0: 永久, 7: 7天, 30: 30天

    var importCodeInput by remember { mutableStateOf("") }
    var importKeyInput by remember { mutableStateOf("") }
    var importNameInput by remember { mutableStateOf("") }

    var showBackupDialog by remember { mutableStateOf(false) }
    var backupsList by remember { mutableStateOf<List<String>>(emptyList()) }
    var showConfirmForcePull by remember { mutableStateOf(false) }

    var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
    var showUpdateDialog by remember { mutableStateOf(false) }
    var isDownloading by remember { mutableStateOf(false) }
    var downloadProgress by remember { mutableStateOf(0) }
    var downloadJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }

    val context = androidx.compose.ui.platform.LocalContext.current
    val versionName = remember(context) {
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            packageInfo.versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }
    val snackbarHostState = remember { SnackbarHostState() }
    val coroutineScope = rememberCoroutineScope()

    val buttonShape = RoundedCornerShape(8.dp)
    val cardShape = RoundedCornerShape(12.dp)

    val startDownloadUpdate = { apkUrl: String, sha256: String? ->
        isDownloading = true
        downloadProgress = 0
        downloadJob = coroutineScope.launch {
            val file = AppUpdater.downloadApk(context, apkUrl, onProgress = { progress ->
                downloadProgress = progress
            }, expectedSha256 = sha256)
            isDownloading = false
            if (file != null) {
                AppUpdater.installApk(context, file)
                showUpdateDialog = false
            } else {
                snackbarHostState.showSnackbar("下载更新失败")
            }
        }
    }

    var activeTab by remember { mutableStateOf(0) }
    val tabTitles = listOf("关于", "提醒", "偏好", "协作", "同步")

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            ScrollableTabRow(
                selectedTabIndex = activeTab,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                edgePadding = 0.dp
            ) {
                tabTitles.forEachIndexed { index, title ->
                    Tab(
                        selected = activeTab == index,
                        onClick = { activeTab = index },
                        text = { Text(title, fontWeight = FontWeight.Bold, maxLines = 1) }
                    )
                }
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(16.dp)
                    .verticalScroll(rememberScrollState())
            ) {
                when (activeTab) {
                    0 -> {
                        // 1. 关于与更新
                        Text("关于与更新", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(bottom = 12.dp))
                        ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = cardShape) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text("当前版本: v$versionName", style = MaterialTheme.typography.bodyMedium)
                                Spacer(Modifier.height(16.dp))
                                var checkingForUpdate by remember { mutableStateOf(false) }
                                Button(
                                    onClick = {
                                        checkingForUpdate = true
                                        coroutineScope.launch {
                                            val result = AppUpdater.checkForUpdates(versionName)
                                            checkingForUpdate = false
                                            when (result) {
                                                is UpdateResult.NewVersion -> {
                                                    updateInfo = result.info
                                                    showUpdateDialog = true
                                                }
                                                is UpdateResult.LatestVersion -> {
                                                    snackbarHostState.showSnackbar("当前已是最新版本")
                                                }
                                                is UpdateResult.Error -> {
                                                    snackbarHostState.showSnackbar("检查更新失败: ${result.message}")
                                                }
                                            }
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    enabled = !checkingForUpdate,
                                    shape = buttonShape
                                ) {
                                    if (checkingForUpdate) {
                                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text("正在检查...")
                                    } else {
                                        Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text("手动检查更新")
                                    }
                                }
                            }
                        }
                    }
                    1 -> {
                        // 2. 提醒设置
                        ReminderSettingsPanel(viewModel, snackbarHostState, coroutineScope)
                    }
                    2 -> {
                        // 3. 偏好习惯
                        Text("偏好习惯设置", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(bottom = 12.dp))
                        ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = cardShape) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text("默认截止日期 (新建无 @ 待办时)", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    val opts = listOf("none" to "无日期", "today" to "今天", "tomorrow" to "明天")
                                    opts.forEach { (value, label) ->
                                        FilterChip(
                                            selected = defaultDueDate == value,
                                            onClick = { defaultDueDate = value },
                                            label = { Text(label) }
                                        )
                                    }
                                }
                                Spacer(modifier = Modifier.height(16.dp))

                                Text("新待办默认插入位置", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    val opts = listOf("top" to "最上方", "bottom" to "最下方")
                                    opts.forEach { (value, label) ->
                                        FilterChip(
                                            selected = defaultInsertion == value,
                                            onClick = { defaultInsertion = value },
                                            label = { Text(label) }
                                        )
                                    }
                                }
                            }
                        }
                        Spacer(modifier = Modifier.height(24.dp))
                        Button(
                            onClick = {
                                viewModel.configManager.defaultDueDate = defaultDueDate
                                viewModel.configManager.defaultInsertion = defaultInsertion
                                coroutineScope.launch {
                                    snackbarHostState.showSnackbar("偏好习惯已保存")
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            shape = buttonShape
                        ) {
                            Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("保存偏好设置")
                        }
                    }
                    3 -> {
                        // 4. 协作共享
                        Text("协作共享设置", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(bottom = 12.dp))
                        ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = cardShape) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                TextDivider("协作时我的昵称")
                                OutlinedTextField(
                                    value = nickname,
                                    onValueChange = {
                                        nickname = it
                                        viewModel.configManager.nickname = it
                                    },
                                    label = { Text("输入昵称 (如: 李四)") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Spacer(Modifier.height(8.dp))

                                if (collaborations.isNotEmpty()) {
                                    TextDivider("已绑定的共享协作清单")
                                    Spacer(Modifier.height(4.dp))
                                    collaborations.forEach { collab ->
                                        Row(
                                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.SpaceBetween
                                        ) {
                                            Column(modifier = Modifier.weight(1f)) {
                                                Text(collab.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Bold)
                                                val expireText = if (collab.expireAt != null) {
                                                    val date = java.time.Instant.ofEpochSecond(collab.expireAt)
                                                        .atZone(java.time.ZoneId.systemDefault())
                                                        .toLocalDate()
                                                    "过期时间: $date"
                                                } else {
                                                    "永久有效"
                                                }
                                                Text(expireText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            }
                                            IconButton(
                                                onClick = {
                                                    viewModel.deleteCollaboration(collab.id)
                                                    
                                                    val active = viewModel.activeSource.value
                                                    if (active is TodoViewModel.ActiveSource.Collaboration && active.collab.id == collab.id) {
                                                        viewModel.switchToPersonal()
                                                    }
                                                    coroutineScope.launch { snackbarHostState.showSnackbar("解绑成功") }
                                                }
                                            ) {
                                                Icon(Icons.Filled.Delete, contentDescription = "解绑", tint = MaterialTheme.colorScheme.error)
                                            }
                                        }
                                    }
                                }

                                TextDivider("导入他人授权码并命名")
                                OutlinedTextField(
                                    value = importCodeInput,
                                    onValueChange = { importCodeInput = it },
                                    label = { Text("粘贴授权口令") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                                if (importCodeInput.trim().startsWith("tdsync://")) {
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(
                                        value = importKeyInput,
                                        onValueChange = { importKeyInput = it },
                                        label = { Text("输入 12 位提取密钥") },
                                        modifier = Modifier.fillMaxWidth()
                                    )
                                }
                                Spacer(Modifier.height(8.dp))
                                OutlinedTextField(
                                    value = importNameInput,
                                    onValueChange = { importNameInput = it },
                                    label = { Text("为协作清单命名") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Spacer(Modifier.height(8.dp))
                                Button(
                                    onClick = {
                                        val code = importCodeInput.trim()
                                        val key = importKeyInput.trim()
                                        val name = importNameInput.trim()
                                        if (code.isEmpty()) {
                                            coroutineScope.launch { snackbarHostState.showSnackbar("请输入授权口令") }
                                            return@Button
                                        }
                                        if (code.startsWith("tdsync://") && key.isEmpty()) {
                                            coroutineScope.launch { snackbarHostState.showSnackbar("请输入 12 位提取密钥") }
                                            return@Button
                                        }
                                        if (name.isEmpty()) {
                                            coroutineScope.launch { snackbarHostState.showSnackbar("请输入协作清单名字") }
                                            return@Button
                                        }
                                        viewModel.importCollaboration(code, key, name)
                                        importCodeInput = ""
                                        importKeyInput = ""
                                        importNameInput = ""
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    shape = buttonShape,
                                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
                                ) {
                                    Text("导入口令并绑定")
                                }

                                TextDivider("生成我的共享授权口令")
                                Text("允许被授权者将新待办追加到您的列表中，他们对现有待办仅有只读权限。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.height(8.dp))
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Text("口令有效期：", style = MaterialTheme.typography.bodyMedium)
                                    val expireLabels = listOf("永久", "7天", "30天")
                                    val expireValues = listOf(0, 7, 30)
                                    expireValues.forEachIndexed { idx, days ->
                                        FilterChip(
                                            selected = shareExpireDays == days,
                                            onClick = { shareExpireDays = days },
                                            label = { Text(expireLabels[idx]) }
                                        )
                                    }
                                }
                                Spacer(Modifier.height(8.dp))
                                Button(
                                    onClick = {
                                        if (!viewModel.configManager.isConfigured()) {
                                            coroutineScope.launch {
                                                snackbarHostState.showSnackbar("请先在同步页配置并保存您的 WebDAV 账号")
                                            }
                                            return@Button
                                        }
                                        try {
                                            val expireDaysVal = if (shareExpireDays > 0) shareExpireDays else null
                                            val (code, key) = viewModel.generateShareCode(expireDaysVal)
                                            shareCodeOutput = code
                                            shareKeyOutput = key
                                        } catch (e: Exception) {
                                            coroutineScope.launch {
                                                snackbarHostState.showSnackbar("生成口令失败: ${e.message}")
                                            }
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    shape = buttonShape,
                                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                                ) {
                                    Text("生成授权口令")
                                }
                                
                                if (shareCodeOutput.isNotEmpty()) {
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(
                                        value = shareCodeOutput,
                                        onValueChange = {},
                                        readOnly = true,
                                        label = { Text("加密授权码") },
                                        modifier = Modifier.fillMaxWidth()
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    Button(
                                        onClick = {
                                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                            val clip = android.content.ClipData.newPlainText("tdsync_code", shareCodeOutput)
                                            clipboard.setPrimaryClip(clip)
                                            coroutineScope.launch { snackbarHostState.showSnackbar("加密授权码已复制") }
                                        },
                                        modifier = Modifier.fillMaxWidth(),
                                        shape = buttonShape,
                                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer)
                                    ) {
                                        Text("复制加密授权码")
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(
                                        value = shareKeyOutput,
                                        onValueChange = {},
                                        readOnly = true,
                                        label = { Text("提取密钥") },
                                        modifier = Modifier.fillMaxWidth()
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    Button(
                                        onClick = {
                                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                            val clip = android.content.ClipData.newPlainText("tdsync_key", shareKeyOutput)
                                            clipboard.setPrimaryClip(clip)
                                            coroutineScope.launch { snackbarHostState.showSnackbar("提取密钥已复制") }
                                        },
                                        modifier = Modifier.fillMaxWidth(),
                                        shape = buttonShape,
                                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer)
                                    ) {
                                        Text("复制提取密钥")
                                    }
                                }
                            }
                        }
                    }
                    4 -> {
                        // 5. 同步与数据维护
                        Text("坚果云 WebDAV 设置", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(bottom = 12.dp))

                        ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = cardShape) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                OutlinedTextField(
                                    value = serverUrl,
                                    onValueChange = { serverUrl = it },
                                    label = { Text("WebDAV 服务器地址") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                OutlinedTextField(
                                    value = username,
                                    onValueChange = { username = it },
                                    label = { Text("坚果云账号 (邮箱)") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                OutlinedTextField(
                                    value = appPassword,
                                    onValueChange = { appPassword = it },
                                    label = { Text("第三方应用密码") },
                                    visualTransformation = PasswordVisualTransformation(),
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                OutlinedTextField(
                                    value = filePath,
                                    onValueChange = { filePath = it },
                                    label = { Text("云端文件路径") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                            }
                        }

                        Spacer(modifier = Modifier.height(24.dp))
                        Button(
                            onClick = {
                                viewModel.saveConfig(serverUrl, username, appPassword, filePath)
                                coroutineScope.launch {
                                    snackbarHostState.showSnackbar("连接配置已保存")
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            shape = buttonShape
                        ) {
                            Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("保存连接设置")
                        }

                        TextDivider("数据维护")
                        ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = cardShape) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text("如果因为误操作同步导致数据丢失，可以从本地自动生成的快照中恢复，或从云端强制覆盖本地数据。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.height(16.dp))
                                Button(
                                    onClick = {
                                        coroutineScope.launch {
                                            backupsList = viewModel.listBackups()
                                            showBackupDialog = true
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    shape = buttonShape,
                                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
                                ) {
                                    Icon(Icons.Filled.List, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text("历史数据恢复")
                                }
                                Spacer(Modifier.height(8.dp))
                                Button(
                                    onClick = { showConfirmForcePull = true },
                                    modifier = Modifier.fillMaxWidth(),
                                    shape = buttonShape,
                                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer)
                                ) {
                                    Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text("强制从云端覆盖本地")
                                }
                            }
                        }
                    }
                }
                if (showConfirmForcePull) {
                    AlertDialog(
                        onDismissRequest = { showConfirmForcePull = false },
                        title = { Text("强制覆盖本地数据") },
                        text = { Text("此操作将下载云端数据并直接覆盖您手机上的本地待办列表！本地未同步的改动将会丢失。确认执行？") },
                        confirmButton = {
                            Button(
                                onClick = {
                                    showConfirmForcePull = false
                                    viewModel.forcePullCloud()
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar("强制拉取已触发，请稍后回首页查看")
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                            ) { Text("确认覆盖") }
                        },
                        dismissButton = {
                            TextButton(onClick = { showConfirmForcePull = false }) { Text("取消") }
                        }
                    )
                }
            }

            if (showBackupDialog) {
                AlertDialog(
                    onDismissRequest = { showBackupDialog = false },
                    title = { Text("选择要恢复的备份") },
                    text = {
                        if (backupsList.isEmpty()) {
                            Text("暂无本地备份记录。")
                        } else {
                            LazyColumn(modifier = Modifier.fillMaxWidth().height(200.dp)) {
                                items(backupsList) { backup ->
                                    TextButton(onClick = {
                                        coroutineScope.launch {
                                            val success = viewModel.restoreFromBackup(backup)
                                            if (success) {
                                                snackbarHostState.showSnackbar("成功恢复备份: $backup")
                                            } else {
                                                snackbarHostState.showSnackbar("恢复失败")
                                            }
                                            showBackupDialog = false
                                        }
                                    }, modifier = Modifier.fillMaxWidth()) {
                                        Text(backup)
                                    }
                                }
                            }
                        }
                    },
                    confirmButton = {
                        TextButton(onClick = { showBackupDialog = false }) {
                            Text("关闭")
                        }
                    }
                )
            }

            if (showUpdateDialog && updateInfo != null) {
                AlertDialog(
                    onDismissRequest = {
                        if (!isDownloading) {
                            showUpdateDialog = false
                            updateInfo = null
                        }
                    },
                    title = { Text("发现新版本 v${updateInfo!!.version}") },
                    text = {
                        Column {
                            if (updateInfo!!.notes.isNotEmpty()) {
                                Text("更新日志：", style = MaterialTheme.typography.titleSmall)
                                Text(updateInfo!!.notes, style = MaterialTheme.typography.bodyMedium)
                                Spacer(modifier = Modifier.height(12.dp))
                            }
                            if (isDownloading) {
                                Text("正在下载: $downloadProgress%")
                                LinearProgressIndicator(
                                    progress = { downloadProgress / 100f },
                                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                                )
                            } else {
                                Text("确认开始下载并安装更新？")
                            }
                        }
                    },
                    confirmButton = {
                        if (!isDownloading) {
                            Button(onClick = { startDownloadUpdate(updateInfo!!.apkUrl, updateInfo!!.sha256) }) {
                                Text("立即更新")
                            }
                        } else {
                            TextButton(onClick = {
                                downloadJob?.cancel()
                                isDownloading = false
                                downloadProgress = 0
                            }) {
                                Text("取消下载")
                            }
                        }
                    },
                    dismissButton = {
                        if (!isDownloading) {
                            TextButton(onClick = {
                                showUpdateDialog = false
                                updateInfo = null
                            }) {
                                Text("稍后再说")
                            }
                        }
                    }
                )
            }
        }
    }
}

@Composable
private fun ReminderSettingsPanel(
    viewModel: TodoViewModel,
    snackbarHostState: SnackbarHostState,
    coroutineScope: kotlinx.coroutines.CoroutineScope
) {
    val todoData by viewModel.todoData.collectAsState()
    val reminderSettings = todoData.reminderSettings

    var enabled by remember(reminderSettings.enabled) { mutableStateOf(reminderSettings.enabled) }
    var privacyMode by remember(reminderSettings.privacyMode) { mutableStateOf(reminderSettings.privacyMode) }
    var globalRules by remember(reminderSettings.globalRules) { mutableStateOf(reminderSettings.globalRules) }
    var showPresetDialog by remember { mutableStateOf(false) }

    Text("提醒设置", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(bottom = 12.dp))

    ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text("开启提醒功能", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Switch(
                    checked = enabled,
                    onCheckedChange = { isChecked ->
                        enabled = isChecked
                        viewModel.updateReminderSettings(reminderSettings.copy(enabled = isChecked))
                    }
                )
            }

            if (enabled) {
                Spacer(Modifier.height(10.dp))

                var showPermissionDialog by remember { mutableStateOf(false) }
                val context = androidx.compose.ui.platform.LocalContext.current

                val hasNotif = com.todo.app.notification.PermissionHelper.isNotificationPermissionGranted(context)
                val hasAlarm = com.todo.app.notification.PermissionHelper.checkExactAlarmPermission(context)
                val hasBattery = com.todo.app.notification.PermissionHelper.checkBatteryOptimizationPermission(context)
                val allGranted = hasNotif && hasAlarm && hasBattery

                OutlinedButton(
                    onClick = { showPermissionDialog = true },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Icon(
                        if (allGranted) Icons.Default.Check else Icons.Default.Warning,
                        contentDescription = null,
                        tint = if (allGranted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (allGranted) "系统提醒权限：已全部开启" else "检测并开启必要提醒权限",
                        color = if (allGranted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
                    )
                }

                if (showPermissionDialog) {
                    AlertDialog(
                        onDismissRequest = { showPermissionDialog = false },
                        title = { Text("提醒权限检测", fontWeight = FontWeight.Bold) },
                        text = {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(
                                    "为保证提醒能准时到达，请确保以下系统权限已开启：",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )

                                // 1. 通知权限
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("通知权限", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                                        Text("允许应用弹出通知消息", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    if (hasNotif) {
                                        Text("已开启", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                                    } else {
                                        TextButton(onClick = {
                                            com.todo.app.notification.PermissionHelper.openNotificationSettings(context)
                                        }) {
                                            Text("去开启")
                                        }
                                    }
                                }

                                HorizontalDivider()

                                // 2. 精确闹钟权限
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("精确闹钟权限", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                                        Text("允许应用准时触发闹钟", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    if (hasAlarm) {
                                        Text("已开启", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                                    } else {
                                        TextButton(onClick = {
                                            com.todo.app.notification.PermissionHelper.requestExactAlarmPermission(context)
                                        }) {
                                            Text("去开启")
                                        }
                                    }
                                }

                                HorizontalDivider()

                                // 3. 忽略电池优化
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("后台运行 / 忽略电池优化", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                                        Text("防止锁屏后被系统休眠杀死", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    if (hasBattery) {
                                        Text("已开启", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                                    } else {
                                        TextButton(onClick = {
                                            com.todo.app.notification.PermissionHelper.requestBatteryOptimizationPermission(context)
                                        }) {
                                            Text("去开启")
                                        }
                                    }
                                }
                            }
                        },
                        confirmButton = {
                            TextButton(onClick = { showPermissionDialog = false }) {
                                Text("完成")
                            }
                        }
                    )
                }

                Spacer(Modifier.height(12.dp))
                TextDivider("提醒模式与规则")
                Spacer(Modifier.height(8.dp))
                Text("单项任务通知模式", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(4.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    FilterChip(
                        selected = !privacyMode,
                        onClick = {
                            privacyMode = false
                            viewModel.updateReminderSettings(reminderSettings.copy(privacyMode = false))
                        },
                        label = { Text("明细模式") }
                    )
                    FilterChip(
                        selected = privacyMode,
                        onClick = {
                            privacyMode = true
                            viewModel.updateReminderSettings(reminderSettings.copy(privacyMode = true))
                        },
                        label = { Text("隐私模式") }
                    )
                }

                Spacer(Modifier.height(16.dp))
                TextDivider("全局定时提醒")
                Spacer(Modifier.height(8.dp))

                Row(
                    modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = {
                            val newRule = com.todo.app.data.model.GlobalReminderRule(
                                id = UUID.randomUUID().toString(),
                                enabled = true,
                                time = "12:00",
                                condition = "unconditional",
                                taskScope = "all",
                                title = "",
                                body = "到了设定的提醒时间（12:00），记得按时处理工作与学习"
                            )
                            val updatedList = (globalRules + newRule).sortedBy { it.time }
                            globalRules = updatedList
                            viewModel.updateReminderSettings(reminderSettings.copy(globalRules = updatedList))
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
                    ) {
                        Text("+ 新增规则")
                    }

                    Button(
                        onClick = { showPresetDialog = true },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.tertiary)
                    ) {
                        Text("💡 导入预设")
                    }
                }

                globalRules.forEachIndexed { index, rule ->
                    GlobalRuleCard(
                        rule = rule,
                        allTodos = todoData.todos,
                        onUpdate = { updatedRule ->
                            val updatedList = globalRules.toMutableList()
                            updatedList[index] = updatedRule
                            val sortedList = updatedList.sortedBy { it.time }
                            globalRules = sortedList
                            viewModel.updateReminderSettings(reminderSettings.copy(globalRules = sortedList))
                        },
                        onDelete = {
                            val updatedList = globalRules.toMutableList()
                            updatedList.removeAt(index)
                            val sortedList = updatedList.sortedBy { it.time }
                            globalRules = sortedList
                            viewModel.updateReminderSettings(reminderSettings.copy(globalRules = sortedList))
                        }
                    )
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
    }

    if (showPresetDialog) {
        var sel1 by remember { mutableStateOf(true) }
        var sel2 by remember { mutableStateOf(true) }
        var sel3 by remember { mutableStateOf(true) }
        val allSelected = sel1 && sel2 && sel3

        AlertDialog(
            onDismissRequest = { showPresetDialog = false },
            title = { Text("💡 导入预设提醒规则", fontWeight = FontWeight.Bold) },
            text = {
                Column(modifier = Modifier.padding(vertical = 4.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable {
                            val next = !allSelected
                            sel1 = next; sel2 = next; sel3 = next
                        },
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Checkbox(
                            checked = allSelected,
                            onCheckedChange = { checked ->
                                sel1 = checked
                                sel2 = checked
                                sel3 = checked
                            }
                        )
                        Text("全选", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                    }

                    Divider()

                    Row(
                        modifier = Modifier.fillMaxWidth().clickable { sel1 = !sel1 },
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Checkbox(checked = sel1, onCheckedChange = { sel1 = it })
                        Text("12:00 | 每一个不曾起舞...", style = MaterialTheme.typography.bodySmall)
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth().clickable { sel2 = !sel2 },
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Checkbox(checked = sel2, onCheckedChange = { sel2 = it })
                        Text("16:00 | Do not go gentle into...", style = MaterialTheme.typography.bodySmall)
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth().clickable { sel3 = !sel3 },
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Checkbox(checked = sel3, onCheckedChange = { sel3 = it })
                        Text("20:00 | 截至（20:00）...", style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val newPresets = mutableListOf<com.todo.app.data.model.GlobalReminderRule>()
                        if (sel1) {
                            newPresets.add(
                                com.todo.app.data.model.GlobalReminderRule(
                                    id = UUID.randomUUID().toString(),
                                    enabled = true,
                                    time = "12:00",
                                    condition = "none_completed",
                                    taskScope = "all",
                                    title = "",
                                    body = "每一个不曾起舞的日子，都是对生命的辜负"
                                )
                            )
                        }
                        if (sel2) {
                            newPresets.add(
                                com.todo.app.data.model.GlobalReminderRule(
                                    id = UUID.randomUUID().toString(),
                                    enabled = true,
                                    time = "16:00",
                                    condition = "unconditional",
                                    taskScope = "all",
                                    title = "",
                                    body = "Do not go gentle into that good night"
                                )
                            )
                        }
                        if (sel3) {
                            newPresets.add(
                                com.todo.app.data.model.GlobalReminderRule(
                                    id = UUID.randomUUID().toString(),
                                    enabled = true,
                                    time = "20:00",
                                    condition = "any_remaining",
                                    taskScope = "today_only",
                                    title = "",
                                    body = "截至（20:00），仅今日任务还有 {remaining_count} 项未完成"
                                )
                            )
                        }
                        if (newPresets.isNotEmpty()) {
                            val updatedList = (globalRules + newPresets).sortedBy { it.time }
                            globalRules = updatedList
                            viewModel.updateReminderSettings(reminderSettings.copy(globalRules = updatedList))
                        }
                        showPresetDialog = false
                    }
                ) {
                    Text("导入选中项")
                }
            },
            dismissButton = {
                TextButton(onClick = { showPresetDialog = false }) { Text("取消") }
            }
        )
    }
}

@Composable
private fun GlobalRuleCard(
    rule: com.todo.app.data.model.GlobalReminderRule,
    allTodos: List<com.todo.app.data.model.Todo> = emptyList(),
    onUpdate: (com.todo.app.data.model.GlobalReminderRule) -> Unit,
    onDelete: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }

    var localTime by remember(rule.time, expanded) { mutableStateOf(rule.time) }
    var localCondition by remember(rule.condition, expanded) { mutableStateOf(rule.condition) }
    var localTaskScope by remember(rule.taskScope, expanded) { mutableStateOf(rule.taskScope) }
    var localTitle by remember(rule.title, expanded) { mutableStateOf(rule.title) }
    var localBody by remember(rule.body, expanded) { mutableStateOf(rule.body) }

    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(
                        checked = rule.enabled,
                        onCheckedChange = { onUpdate(rule.copy(enabled = it)) }
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(rule.time, fontWeight = FontWeight.Bold)
                }

                Row {
                    IconButton(onClick = { expanded = !expanded }) {
                        Text(if (expanded) "▲" else "▼")
                    }
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Filled.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error)
                    }
                }
            }

            if (expanded) {
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = localTime,
                    onValueChange = { localTime = it },
                    label = { Text("提醒时间 (HH:mm)") },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(6.dp))

                Text("触发判定条件", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    val condOpts = listOf("none_completed" to "未完成任何", "any_remaining" to "存在未完成", "unconditional" to "无条件")
                    condOpts.forEach { (valStr, label) ->
                        FilterChip(
                            selected = localCondition == valStr,
                            onClick = { localCondition = valStr },
                            label = { Text(label, fontSize = 11.sp) }
                        )
                    }
                }

                if (localCondition != "unconditional") {
                    Spacer(Modifier.height(6.dp))
                    Text("任务类型筛选", style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        val scopeOpts = listOf("all" to "全部任务", "today_only" to "仅今日任务（含逾期）", "recurring_only" to "仅打卡")
                        scopeOpts.forEach { (valStr, label) ->
                            FilterChip(
                                selected = localTaskScope == valStr,
                                onClick = { localTaskScope = valStr },
                                label = { Text(label, fontSize = 11.sp) }
                            )
                        }
                    }
                    Text(
                        text = "💡 说明：所有统计均基于【今日视角】，计算今日的任务情况",
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                        color = androidx.compose.ui.graphics.Color(0xFF10B981),
                        modifier = Modifier.padding(top = 2.dp)
                    )
                }

                Spacer(Modifier.height(6.dp))
                OutlinedTextField(
                    value = localTitle,
                    onValueChange = { localTitle = it },
                    label = { Text("通知标题 (留空默认 Todo)") },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(6.dp))
                var showVarMenu by remember { mutableStateOf(false) }

                Box(modifier = Modifier.fillMaxWidth()) {
                    OutlinedTextField(
                        value = localBody,
                        onValueChange = { newValue ->
                            localBody = newValue
                            val lastOpen = newValue.lastIndexOf('{')
                            val lastClose = newValue.lastIndexOf('}')
                            showVarMenu = lastOpen != -1 && lastOpen > lastClose
                        },
                        label = { Text("通知正文 (输入 { 自动弹出变量菜单)") },
                        modifier = Modifier.fillMaxWidth()
                    )

                    DropdownMenu(
                        expanded = showVarMenu,
                        onDismissRequest = { showVarMenu = false },
                        modifier = Modifier.fillMaxWidth(0.85f)
                    ) {
                        val varList = listOf(
                            "{remaining_count}" to "未完成任务数",
                            "{completed_count}" to "已完成任务数",
                            "{total_count}" to "总任务数量",
                            "{overdue_count}" to "逾期任务数量",
                            "{completion_rate}" to "任务完成百分比",
                            "{time}" to "系统实时精确时间",
                            "{date}" to "系统今日日期",
                            "{weekday}" to "当前星期几"
                        )
                        varList.forEach { (code, label) ->
                            DropdownMenuItem(
                                text = {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Text(code, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, fontSize = 12.sp)
                                        Spacer(Modifier.width(8.dp))
                                        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
                                    }
                                },
                                onClick = {
                                    val lastOpen = localBody.lastIndexOf('{')
                                    if (lastOpen != -1) {
                                        localBody = localBody.substring(0, lastOpen) + code
                                    } else {
                                        localBody += code
                                    }
                                    showVarMenu = false
                                }
                            )
                        }
                    }
                }

                if (localBody.contains("{") && localBody.contains("}")) {
                    Spacer(Modifier.height(4.dp))
                    val today = java.time.LocalDate.now()
                    val todayStr = today.toString()
                    val thisWeekStr = com.todo.app.data.model.weekStringOf(today)
                    val thisMonthStr = com.todo.app.data.model.monthStringOf(today)

                    val activeTodos = allTodos.filter { !it.deleted }
                    val isRecurringTask = { t: com.todo.app.data.model.Todo ->
                        if (t.recurring == com.todo.app.data.model.RecurringType.DAILY_REPEAT) {
                            val d = t.date
                            d == null || d == todayStr
                        } else if (t.taskType == com.todo.app.data.model.TaskType.WEEKLY_CHECKIN) {
                            t.date == thisWeekStr || t.date == null
                        } else if (t.taskType == com.todo.app.data.model.TaskType.MONTHLY_CHECKIN) {
                            t.date == thisMonthStr || t.date == null
                        } else {
                            false
                        }
                    }

                    val scopedTodos = activeTodos.filter {
                        when (localTaskScope) {
                            "today_only" -> !isRecurringTask(it) && (it.date == todayStr || it.isOverdue(todayStr))
                            "recurring_only" -> isRecurringTask(it)
                            else -> it.date == todayStr || it.isOverdue(todayStr) || isRecurringTask(it)
                        }
                    }

                    val isTaskCompletedToday = { t: com.todo.app.data.model.Todo ->
                        if (t.completed) {
                            true
                        } else if (t.taskType == com.todo.app.data.model.TaskType.WEEKLY_CHECKIN || t.taskType == com.todo.app.data.model.TaskType.MONTHLY_CHECKIN) {
                            t.completedDates.any { it.startsWith(todayStr) }
                        } else {
                            false
                        }
                    }

                    val realOverdue = if (localTaskScope == "recurring_only") 0 else scopedTodos.count { it.isOverdue(todayStr) }
                    val realRemaining = scopedTodos.count { !isTaskCompletedToday(it) }
                    val realCompleted = scopedTodos.count { isTaskCompletedToday(it) }
                    val realTotal = scopedTodos.size
                    val realRate = if (realTotal > 0) Math.round((realCompleted.toDouble() / realTotal) * 100).toInt() else 0

                    val now = java.time.LocalTime.now()
                    val nowTimeStr = String.format("%02d:%02d", now.hour, now.minute)
                    val todayDate = java.time.LocalDate.now()
                    val todayDateStr = String.format("%02d月%02d日", todayDate.monthValue, todayDate.dayOfMonth)
                    val weekdays = arrayOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
                    val weekdayStr = weekdays[todayDate.dayOfWeek.value % 7]

                    val previewText = localBody
                        .replace("{remaining_count}", realRemaining.toString())
                        .replace("{completed_count}", realCompleted.toString())
                        .replace("{total_count}", realTotal.toString())
                        .replace("{overdue_count}", realOverdue.toString())
                        .replace("{completion_rate}", "$realRate%")
                        .replace("{time}", nowTimeStr)
                        .replace("{now_time}", nowTimeStr)
                        .replace("{date}", todayDateStr)
                        .replace("{today_date}", todayDateStr)
                        .replace("{weekday}", weekdayStr)

                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f),
                        shape = RoundedCornerShape(6.dp),
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
                    ) {
                        Column(modifier = Modifier.padding(8.dp)) {
                            Text("✨ 实时效果渲染预览：", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                            Text(previewText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }

                Spacer(Modifier.height(10.dp))
                Button(
                    onClick = {
                        val updated = rule.copy(
                            time = localTime,
                            condition = localCondition,
                            taskScope = localTaskScope,
                            title = localTitle,
                            body = localBody
                        )
                        onUpdate(updated)
                        expanded = false
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                ) {
                    Icon(Icons.Filled.Check, contentDescription = "确认保存", modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("确认保存", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun TextDivider(text: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Divider(modifier = Modifier.weight(1f))
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 8.dp)
        )
        Divider(modifier = Modifier.weight(1f))
    }
}
