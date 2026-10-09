package com.todo.app.data

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class WebDavClient(
    private val serverUrl: String,
    private val username: String,
    private val appPassword: String,
    private val client: OkHttpClient = defaultClient
) {
    companion object {
        private const val TAG = "WebDavClient"
        // 凭据快照各自构造请求，复用传输层避免每次同步重新创建连接池。
        private val defaultClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
        // NOTE: XML responses from WebDAV are parsed using regex here, which is fragile.
        // A proper implementation should use XmlPullParser or a dedicated WebDAV library.
        // This regex approach works for simple PROPFIND responses but may break on
        // complex XML structures, CDATA sections, or namespace variations.
        private val DISPLAY_NAME_REGEX = Regex("""<(?:[a-zA-Z0-9_]+:)?displayname>([^<]+)</(?:[a-zA-Z0-9_]+:)?displayname>""")
    }

    // 协作请求要求明确目标，重定向由用户检查地址后重试，避免转发凭据。
    private val collaborationClient = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    class CollaborationHttpException(status: Int, operation: String = "GET") :
        WebDavHttpException(status, operation, WebDavContext.COLLABORATION)

    /**
     * Build a full WebDAV URL from a relative path.
     */
    private fun buildUrl(relativePath: String): String {
        val encodedPath = encodePath(relativePath)
        val url = if (serverUrl.endsWith("/")) "$serverUrl$encodedPath" else "$serverUrl/$encodedPath"
        if (url.toHttpUrlOrNull() == null) throw IOException("WebDAV 地址无效，请检查同步配置。")
        return url
    }

    private fun encodePath(path: String): String {
        return path.split("/").joinToString("/") { segment ->
            if (segment.isEmpty()) "" else java.net.URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
        }
    }

    /**
     * List contents of a given directory path.
     * @param directoryPath The relative directory path to list. Defaults to "我的坚果云/".
     */
    suspend fun listRoot(directoryPath: String = "我的坚果云/"): String = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val xmlBody = "<?xml version=\"1.0\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:displayname/></D:prop></D:propfind>"
        val body = xmlBody.toRequestBody("application/xml; charset=utf-8".toMediaType())
        val targetUrl = buildUrl(directoryPath)
        val request = Request.Builder()
            .url(targetUrl)
            .header("Authorization", credential)
            .header("Depth", "1")
            .method("PROPFIND", body)
            .build()
        try {
            client.newCall(request).execute().use { response ->
                val xml = response.body?.string() ?: ""
                // Regex-based XML parsing (see TAG companion note for limitations)
                val names = DISPLAY_NAME_REGEX.findAll(xml)
                    .map { it.groupValues[1] }
                    .filter { it.isNotBlank() && it != directoryPath.trimEnd('/') }
                    .toList()
                return@withContext "【${directoryPath.trimEnd('/')}】内有: " + names.joinToString(", ")
            }
        } catch (e: Exception) {
            Log.e(TAG, "listRoot failed for path: $directoryPath", e)
            return@withContext "获取目录失败: ${e.message}"
        }
    }

    suspend fun checkFolderExists(folderPath: String): Boolean = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val xmlBody = "<?xml version=\"1.0\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:displayname/></D:prop></D:propfind>"
        val body = xmlBody.toRequestBody("application/xml; charset=utf-8".toMediaType())
        val targetUrl = buildUrl(folderPath)
        val request = Request.Builder()
            .url(targetUrl)
            .header("Authorization", credential)
            .header("Depth", "0")
            .method("PROPFIND", body)
            .build()
        try {
            executeRequest(request, WebDavContext.PERSONAL_SYNC)
            true
        } catch (e: WebDavHttpException) {
            if (e.status == 404) false else throw e
        }
    }

    /**
     * 从 WebDAV 下载文件
     * @param filePath 相对路径，如 "todo_data.json" 或 "MyTodos/todo_data.json"
     * @return 文件内容字符串；仅目标文件确实缺失且父目录可用时返回 null，其他失败抛出异常。
     */
    suspend fun downloadFile(filePath: String): String? = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val url = buildUrl(filePath)

        val request = Request.Builder()
            .url(url)
            .header("Authorization", credential)
            .get()
            .build()

        try {
            executeRequest(request, WebDavContext.PERSONAL_SYNC).content
        } catch (e: WebDavHttpException) {
            if (e.status != 404) throw e
            val parentPath = filePath.substringBeforeLast('/', "")
            if (parentPath.isNotEmpty() && !checkFolderExists(parentPath)) {
                throw WebDavHttpException(404, "PROPFIND", message = "云端同步目录 [$parentPath] 不存在（404），请先创建该文件夹。")
            }
            null
        }
    }


    /**
     * 上传文件内容到 WebDAV
     * @param filePath 相对路径
     * @param content JSON content to upload
     * @return true if upload succeeded
     * @throws IOException HTTP 非成功或网络失败；失败不会返回 false。
     */
    suspend fun uploadFile(filePath: String, content: String): Boolean = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val url = buildUrl(filePath)

        val body = content.toRequestBody("application/json; charset=utf-8".toMediaType())

        val request = Request.Builder()
            .url(url)
            .header("Authorization", credential)
            .put(body)
            .build()

        // 保留成功时的布尔返回兼容调用者；失败必须抛出，不再返回可被忽略的 false。
        executeRequest(request, WebDavContext.PERSONAL_SYNC)
        true
    }

    data class CollabDownloadResult(
        val content: String,
        val serverTime: String
    )

    suspend fun downloadCollaborationFile(filePath: String): CollabDownloadResult {
        val credential = Credentials.basic(username, appPassword)
        val url = buildUrl(filePath)

        val request = Request.Builder()
            .url(url)
            .header("Authorization", credential)
            .get()
            .build()

        return executeRequest(request, WebDavContext.COLLABORATION)
    }

    suspend fun uploadCollaborationFile(filePath: String, content: String) {
        val request = Request.Builder().url(buildUrl(filePath))
            .header("Authorization", Credentials.basic(username, appPassword))
            .put(content.toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        executeRequest(request, WebDavContext.COLLABORATION)
    }

    private suspend fun executeRequest(request: Request, context: WebDavContext): CollabDownloadResult {
        try {
            return suspendCancellableCoroutine { continuation ->
                val requester = if (context == WebDavContext.COLLABORATION) collaborationClient else client
                val call = requester.newCall(request)
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use {
                            try {
                                if (!it.isSuccessful) throw if (context == WebDavContext.COLLABORATION)
                                    CollaborationHttpException(it.code, request.method)
                                else WebDavHttpException(it.code, request.method, context)
                                val result = CollabDownloadResult(it.body?.string() ?: "", it.header("Date") ?: "")
                                if (continuation.isActive) continuation.resume(result)
                            } catch (e: Exception) {
                                if (continuation.isActive) continuation.resumeWithException(e)
                            }
                        }
                    }
                })
            }
        } catch (e: WebDavHttpException) {
            throw e
        } catch (_: IOException) {
            throw WebDavNetworkException(context, request.method)
        }
    }
}
