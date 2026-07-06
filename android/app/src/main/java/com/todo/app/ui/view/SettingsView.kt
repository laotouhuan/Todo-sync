package com.todo.app.ui.view

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
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
import com.todo.app.ui.viewmodel.TodoViewModel
import com.todo.app.utils.AppUpdater
import com.todo.app.utils.UpdateInfo
import com.todo.app.utils.UpdateResult
import kotlinx.coroutines.launch

@Composable
fun SettingsView(viewModel: TodoViewModel) {
    val configManager = viewModel.configManager
    var serverUrl by remember { mutableStateOf(configManager.webDavUrl) }
    var username by remember { mutableStateOf(configManager.username) }
    var appPassword by remember { mutableStateOf(configManager.appPassword) }
    var filePath by remember { mutableStateOf(configManager.filePath) }
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

    val startDownloadUpdate = { apkUrl: String ->
        isDownloading = true
        downloadProgress = 0
        downloadJob = coroutineScope.launch {
            val file = AppUpdater.downloadApk(context, apkUrl) { progress ->
                downloadProgress = progress
            }
            isDownloading = false
            if (file != null) {
                AppUpdater.installApk(context, file)
                showUpdateDialog = false
            } else {
                snackbarHostState.showSnackbar("下载更新失败")
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState())
        ) {
            Text("坚果云 WebDAV 设置", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(bottom = 16.dp))
            
            ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)) {
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
            } // Close ElevatedCard
            
            Spacer(modifier = Modifier.height(24.dp))
            Button(
                onClick = {
                    configManager.webDavUrl = serverUrl
                    configManager.username = username
                    configManager.appPassword = appPassword
                    configManager.filePath = filePath
                    viewModel.resetWebDavClient()
                    coroutineScope.launch {
                        snackbarHostState.showSnackbar("配置已保存")
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)
            ) {
                Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("保存配置")
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = {
                    viewModel.syncWithCloud()
                    coroutineScope.launch {
                        snackbarHostState.showSnackbar("同步已触发")
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.tertiary)
            ) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("立即同步 (根据时间戳)")
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = {
                    showConfirmForcePull = true
                },
                modifier = Modifier.fillMaxWidth(),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("强制从云端恢复到手机 (覆盖本地)")
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

            Text("高级与维护", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(bottom = 16.dp))
            ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("如果因为误操作同步导致数据丢失，可以从本地自动生成的快照中恢复。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = {
                            backupsList = viewModel.listBackups()
                            showBackupDialog = true
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
                    ) {
                        Icon(Icons.Filled.List, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("历史数据恢复")
                    }
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

            Spacer(modifier = Modifier.height(24.dp))

            Text("关于与更新", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(bottom = 16.dp))
            ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)) {
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
                                        snackbarHostState.showSnackbar("检测更新失败: ${result.message}")
                                    }
                                }
                            }
                        },
                        enabled = !checkingForUpdate,
                        modifier = Modifier.fillMaxWidth(),
                        shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)
                    ) {
                        Text(if (checkingForUpdate) "正在检查更新..." else "检查更新")
                    }
                }
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
                            Button(onClick = { startDownloadUpdate(updateInfo!!.apkUrl) }) {
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
