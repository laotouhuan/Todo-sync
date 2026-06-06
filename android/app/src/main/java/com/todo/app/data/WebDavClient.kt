package com.todo.app.data

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
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun encodePath(path: String): String {
        return path.split("/").joinToString("/") { segment ->
            if (segment.isEmpty()) "" else java.net.URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
        }
    }

    suspend fun listRoot(): String = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val xmlBody = "<?xml version=\"1.0\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:displayname/></D:prop></D:propfind>"
        val body = xmlBody.toRequestBody("application/xml; charset=utf-8".toMediaType())
        val encodedRoot = encodePath("我的坚果云/")
        val targetUrl = if (serverUrl.endsWith("/")) serverUrl + encodedRoot else "$serverUrl/$encodedRoot"
        val request = Request.Builder()
            .url(targetUrl)
            .header("Authorization", credential)
            .header("Depth", "1")
            .method("PROPFIND", body)
            .build()
        try {
            client.newCall(request).execute().use { response ->
                val xml = response.body?.string() ?: ""
                val names = "<(?:[a-zA-Z0-9_]+:)?displayname>([^<]+)</(?:[a-zA-Z0-9_]+:)?displayname>".toRegex()
                    .findAll(xml).map { it.groupValues[1] }.filter { it.isNotBlank() && it != "我的坚果云" }.toList()
                return@withContext "【我的坚果云】内有: " + names.joinToString(", ")
            }
        } catch (e: Exception) {
            return@withContext "获取目录失败: ${e.message}"
        }
    }

    /**
     * 从 WebDAV 下载文件
     * @param filePath 相对路径，如 "todo_data.json" 或 "MyTodos/todo_data.json"
     * @return 文件内容字符串，若失败或不存在则返回 null
     */
    suspend fun downloadFile(filePath: String): String? = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val encodedPath = encodePath(filePath)
        val url = if (serverUrl.endsWith("/")) serverUrl + encodedPath else "$serverUrl/$encodedPath"
        
        val request = Request.Builder()
            .url(url)
            .header("Authorization", credential)
            .get()
            .build()
            
        try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    return@withContext response.body?.string() ?: ""
                } else {
                    throw Exception("HTTP ${response.code}: ${response.message} (请求地址: $url)")
                }
            }
        } catch (e: Exception) {
            throw Exception("网络请求异常: ${e.message}")
        }
    }

    /**
     * 上传文件内容到 WebDAV
     */
    suspend fun uploadFile(filePath: String, content: String): Boolean = withContext(Dispatchers.IO) {
        val credential = Credentials.basic(username, appPassword)
        val encodedPath = encodePath(filePath)
        val url = if (serverUrl.endsWith("/")) serverUrl + encodedPath else "$serverUrl/$encodedPath"
        
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
                    System.err.println("WebDAV PUT Error: ${response.code} ${response.message}")
                }
                return@withContext success
            }
        } catch (e: IOException) {
            e.printStackTrace()
            return@withContext false
        }
    }
}
