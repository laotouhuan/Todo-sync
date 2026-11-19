package com.todo.app.ui.view

import com.todo.app.ui.theme.SupportingText

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import com.todo.app.data.ConfigManager
import com.todo.app.data.repository.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val recoveryFileLimit = 32 * 1024 * 1024

@Serializable
private data class RecoveryFile(
    val pin: RecordDatasetPin,
    val descriptor: String,
    val baseline: String,
    val backup: String? = null,
    val received: List<Artifact> = emptyList()
)

private val recoveryJson = Json { ignoreUnknownKeys = true }

@Composable
internal fun RecordRecoverySettings(config: ConfigManager) {
    val context = LocalContext.current
    val store = remember(context) { RecordRecoveryStore(context.filesDir) }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var selectedPin by remember { mutableStateOf<RecordDatasetPin?>(null) }
    var exportPin by remember { mutableStateOf<RecordDatasetPin?>(null) }
    var recheckTarget by remember { mutableStateOf<RecordRecoveryInput?>(null) }

    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            busy = true
            selectedPin = null
            recheckTarget = null
            status = "正在核对恢复材料…"
            scope.launch {
                try {
                    val (target, preview, localEvidence) = withContext(Dispatchers.IO) {
                        val text = requireNotNull(context.contentResolver.openInputStream(uri)).use { input ->
                            val output = java.io.ByteArrayOutputStream()
                            val buffer = ByteArray(8192)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                require(output.size() + count <= recoveryFileLimit)
                                output.write(buffer, 0, count)
                            }
                            output.toByteArray().decodeToString(throwOnInvalidSequence = true)
                        }
                        val material = recoveryJson.decodeFromString<RecoveryFile>(text)
                        val target = RecordRecoveryInput(material.pin, material.descriptor, material.baseline)
                        val current = store.prepare(target).preview
                        val preview = if (current.journal.fault != null || (material.backup == null && material.received.isEmpty())) current
                        else store.prepare(target.copy(backup = material.backup, received = material.received)).preview
                        Triple(target, preview, current.journal.fault != null || current.journal.resolved_faults.isNotEmpty())
                    }
                    val journal = preview.journal
                    val details = "已知记录 ${journal.records.size} 条，待上传 ${journal.pending.size} 条"
                    status = when {
                        journal.fault != null -> "$details。同步已暂停（${journal.fault.code}）"
                        preview.missing.isNotEmpty() -> "$details。缺少 ${preview.missing.size} 条父记录"
                        else -> {
                            val count = requireNotNull(preview.view).getValue("todos").jsonArray.count {
                                it.jsonObject["deleted"]?.jsonPrimitive?.booleanOrNull != true
                            }
                            "$details。可恢复任务 $count 条"
                        }
                    }
                    if (localEvidence) selectedPin = target.pin
                    if (localEvidence && journal.fault?.code == "RECORD_REMOTE_BYTES_CHANGED") recheckTarget = target
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    status = "无法预览恢复材料，请核对文件、数据集和本机日志。"
                } finally {
                    busy = false
                }
            }
        }
    }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val pin = exportPin
        exportPin = null
        if (uri != null && pin != null) {
            busy = true
            scope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        requireNotNull(context.contentResolver.openOutputStream(uri)).use { store.exportFaultEvidence(pin, it) }
                    }
                    status += "。已导出本机故障证据"
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    status += "。无法导出本机故障证据"
                } finally {
                    busy = false
                }
            }
        }
    }
    Column {
        Text("独立记录恢复预览", style = MaterialTheme.typography.titleSmall)
        OutlinedButton(enabled = !busy && exportPin == null, onClick = { open.launch(arrayOf("application/json", "text/plain")) }) {
            Text("打开恢复材料")
        }
        if (status.isNotEmpty()) SupportingText(status)
        selectedPin?.let { pin ->
            OutlinedButton(enabled = !busy && exportPin == null, onClick = {
                exportPin = pin
                export.launch("record-fault-${pin.dataset_id}.json")
            }) { Text("导出本机故障证据") }
        }
        recheckTarget?.let { target ->
            OutlinedButton(enabled = !busy && exportPin == null, onClick = {
                busy = true
                val endpoint = config.webDavUrl
                val directory = config.filePath.split('/').dropLast(1)
                val username = config.username
                val password = config.appPassword
                scope.launch {
                    try {
                        val transport = RecordWebDavTransport(endpoint, directory, username, password, target.pin)
                        store.recheckFault(target, transport)
                        recheckTarget = null
                        status = "远端对象复核通过，已解除该数据集的暂停。"
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        status = "远端对象未通过复核，该数据集仍暂停。"
                    } finally {
                        busy = false
                    }
                }
            }) { Text("用已保存的 WebDAV 设置复核") }
        }
    }
}
