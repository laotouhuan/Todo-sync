package com.todo.app.data

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class WebDavClient(
    private val serverUrl: String,
    private val username: String,
    private val appPassword: String
) {
    companion object {
        private const val TAG = "WebDavClient"
        // NOTE: XML responses from WebDAV are parsed using regex here, which is fragile.
        // A proper implementation should use XmlPullParser or a dedicated WebDAV library.
        // This regex approach works for simple PROPFIND responses but may break on
        // complex XML structures, CDATA sections, or namespace variations.
        private val DISPLAY_NAME_REGEX = Regex("""<(?:[a-zA-Z0-9_]+:)?displayname>([^<]+)</(?:[a-zA-Z0-9_]+:)?displayname>""")
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

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

    suspend fun downloadCollaborationFile(filePath: String): CollabDownloadResult = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val url = buildUrl(filePath)

        val request = Request.Builder()
            .url(url)
            .header("Authorization", credential)
            .get()
            .build()

        client.newCall(request).execute().use { response ->
            if (response.isSuccessful) {
                val body = response.body?.string() ?: ""
                val serverTime = response.header("Date") ?: ""
                return@withContext CollabDownloadResult(body, serverTime)
            } else if (response.code == 404) {
                throw Exception("文件不存在 (404)")
            } else {
                throw Exception("HTTP ${response.code}: ${response.message}")
            }
        }
    }
}
