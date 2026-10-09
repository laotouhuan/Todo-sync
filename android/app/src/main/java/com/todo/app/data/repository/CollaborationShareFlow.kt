package com.todo.app.data.repository

import com.todo.app.data.WebDavClient
import com.todo.app.data.WebDavContext
import com.todo.app.data.WebDavHttpException
import com.todo.app.data.WebDavNetworkException
import com.todo.app.data.model.ShareCodePayload
import com.todo.app.data.model.TodoData
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** 验证同一份凭据快照后才生成或提交；网络请求不持有文件锁。 */
internal class CollaborationShareFlow(
    private val download: suspend (ShareCodePayload) -> WebDavClient.CollabDownloadResult = {
        WebDavClient(it.url, it.user, it.pass).downloadCollaborationFile(it.path)
    }
) {
    suspend fun validate(payload: ShareCodePayload, context: WebDavContext = WebDavContext.COLLABORATION) {
        val url = payload.url.toHttpUrlOrNull()
        require(url != null && url.isHttps && url.username.isEmpty() && url.password.isEmpty() &&
            url.query == null && url.fragment == null) { "WebDAV 地址必须是有效的 HTTPS 地址，且不包含凭据、查询或片段" }
        require(payload.url == payload.url.trim() && payload.user == payload.user.trim()) {
            "地址或账号首尾含空白，请检查并保存连接设置"
        }
        require(payload.user.isNotBlank() && !payload.user.contains(':') && payload.pass.isNotBlank()) { "WebDAV 账号或应用密码无效" }
        require(payload.path.isNotBlank() && payload.path == payload.path.trim() &&
            !payload.path.startsWith('/') && !payload.path.contains('\\') &&
            payload.path.split('/').none { it == "." || it == ".." } && !payload.path.endsWith('/')) { "云端文件路径无效" }
        require(payload.exp >= 0) { "授权有效期无效" }
        val result = try { download(payload) }
        catch (e: WebDavHttpException) { throw WebDavHttpException(e.status, e.operation, context) }
        catch (e: WebDavNetworkException) { throw WebDavNetworkException(context, e.operation) }
        currentCoroutineContext().ensureActive()
        collaborationExpiryFailure(payload.exp.takeUnless { it == 0L }, result.serverTime)?.let { error(it) }
        try {
            val json = Json { ignoreUnknownKeys = true }
            json.parseToJsonElement(result.content).jsonObject.getValue("todos").jsonArray
            json.decodeFromString<TodoData>(result.content)
        } catch (_: Exception) {
            error(if (context == WebDavContext.COLLABORATION) "分享者待办文件格式无效，请检查同步文件"
                else "你的待办文件格式无效，请检查同步文件")
        }
    }

    suspend fun <T> generate(payload: ShareCodePayload, isCurrent: () -> Boolean, encrypt: (ShareCodePayload) -> T): T {
        validate(payload, WebDavContext.SHARE_GENERATION)
        check(isCurrent()) { "连接配置已修改，请保存后重新生成" }
        return encrypt(payload)
    }

    suspend fun <T> importValidated(payload: ShareCodePayload, commit: suspend () -> T): T {
        validate(payload)
        return commit()
    }
}
