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
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class WebDavClient(
    private val serverUrl: String,
    private val username: String,
    private val appPassword: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()
) {
    companion object {
        private const val TAG = "WebDavClient"
        // NOTE: XML responses from WebDAV are parsed using regex here, which is fragile.
        // A proper implementation should use XmlPullParser or a dedicated WebDAV library.
        // This regex approach works for simple PROPFIND responses but may break on
        // complex XML structures, CDATA sections, or namespace variations.
        private val DISPLAY_NAME_REGEX = Regex("""<(?:[a-zA-Z0-9_]+:)?displayname>([^<]+)</(?:[a-zA-Z0-9_]+:)?displayname>""")
    }

    // 协作请求要求明确目标，重定向由用户检查地址后重试，避免转发凭据。
    private val collaborationClient = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    class CollaborationHttpException(val status: Int) : IOException(when (status) {
        401 -> "对方 WebDAV 认证失败（401）。请让对方确认个人同步成功，并重新生成分享码后导入。"
        403 -> "服务器拒绝访问（403），请对方检查访问权限。"
        404 -> "对方待办文件不存在（404），请确认路径并完成一次同步。"
        in 300..399 -> "服务器返回重定向，请确认 WebDAV 目标地址后重试。"
        else -> "WebDAV 请求失败（$status），请稍后重试。"
    })

    /**
     * Build a full WebDAV URL from a relative path.
     */
    private fun buildUrl(relativePath: String): String {
        val encodedPath = encodePath(relativePath)
        return if (serverUrl.endsWith("/")) "$serverUrl$encodedPath" else "$serverUrl/$encodedPath"
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
            client.newCall(request).execute().use { response ->
                return@withContext response.code == 207 || response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "checkFolderExists failed for: $folderPath", e)
            return@withContext false
        }
    }

    /**
     * 从 WebDAV 下载文件
     * @param filePath 相对路径，如 "todo_data.json" 或 "MyTodos/todo_data.json"
     * @return 文件内容字符串，若失败或不存在则返回 null
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
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    return@withContext response.body?.string() ?: ""
                } else if (response.code == 404) {
                    val lastSlash = filePath.lastIndexOf('/')
                    val parentPath = if (lastSlash != -1) filePath.substring(0, lastSlash) else ""
                    if (parentPath.isNotEmpty()) {
                        if (checkFolderExists(parentPath)) {
                            return@withContext null
                        } else {
                            throw Exception("云端同步目录 [${parentPath}] 不存在，请先在坚果云中手动创建该文件夹。")
                        }
                    } else {
                        return@withContext null
                    }
                } else {
                    throw Exception("HTTP ${response.code}: ${response.message} (请求地址: $url)")
                }
            }
        } catch (e: Exception) {
            if (e.message?.contains("云端同步目录") == true) {
                throw e
            }
            throw Exception("网络请求异常: ${e.message}")
        }
    }


    /**
     * 上传文件内容到 WebDAV
     * @param filePath 相对路径
     * @param content JSON content to upload
     * @return true if upload succeeded
     * @throws IOException if a network error occurs (callers should handle)
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

        try {
            client.newCall(request).execute().use { response ->
                val success = response.isSuccessful
                if (!success) {
                    Log.e(TAG, "WebDAV PUT Error: ${response.code} ${response.message}")
                }
                return@withContext success
            }
        } catch (e: IOException) {
            Log.e(TAG, "WebDAV PUT IOException for: $filePath", e)
            throw e  // Let callers decide how to handle network errors
        }
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

        return executeCollaboration(request)
    }

    suspend fun uploadCollaborationFile(filePath: String, content: String) {
        val request = Request.Builder().url(buildUrl(filePath))
            .header("Authorization", Credentials.basic(username, appPassword))
            .put(content.toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        executeCollaboration(request)
    }

    private suspend fun executeCollaboration(request: Request): CollabDownloadResult {
        try {
            return suspendCancellableCoroutine { continuation ->
                val call = collaborationClient.newCall(request)
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use {
                            try {
                                if (!it.isSuccessful) throw CollaborationHttpException(it.code)
                                val result = CollabDownloadResult(it.body?.string() ?: "", it.header("Date") ?: "")
                                if (continuation.isActive) continuation.resume(result)
                            } catch (e: Exception) {
                                if (continuation.isActive) continuation.resumeWithException(e)
                            }
                        }
                    }
                })
            }
        } catch (e: CollaborationHttpException) {
            throw e
        } catch (_: IOException) {
            throw IOException("无法连接对方服务器，请检查地址和网络后重试。")
        }
    }
}
