package com.todo.app.utils

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException

data class UpdateInfo(
    val version: String,
    val notes: String,
    val apkUrl: String
)

object AppUpdater {
    private val client = OkHttpClient()

    suspend fun checkForUpdates(currentVersion: String): UpdateInfo? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("https://github.com/laotouhuan/Todo-sync/releases/latest/download/latest.json")
            .build()
        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val bodyStr = response.body?.string() ?: return@withContext null
                val json = JSONObject(bodyStr)
                val latestVersion = json.getString("version")
                val notes = json.optString("notes", "")
                val platforms = json.getJSONObject("platforms")

                // Find matching APK url
                var apkUrl: String? = null
                val keys = platforms.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (key.startsWith("android")) {
                        apkUrl = platforms.getJSONObject(key).getString("url")
                        break
                    }
                }

                if (apkUrl != null && isNewerVersion(currentVersion, latestVersion)) {
                    return@withContext UpdateInfo(latestVersion, notes, apkUrl)
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return@withContext null
    }

    private fun isNewerVersion(current: String, latest: String): Boolean {
        val curParts = current.replace("v", "").split(".").mapNotNull { it.toIntOrNull() }
        val latParts = latest.replace("v", "").split(".").mapNotNull { it.toIntOrNull() }
        val length = maxOf(curParts.size, latParts.size)
        for (i in 0 until length) {
            val cur = curParts.getOrElse(i) { 0 }
            val lat = latParts.getOrElse(i) { 0 }
            if (lat > cur) return true
            if (cur > lat) return false
        }
        return false
    }

    suspend fun downloadApk(
        context: Context,
        url: String,
        onProgress: (Int) -> Unit
    ): File? = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).build()
        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val body = response.body ?: return@withContext null
                val contentLength = body.contentLength()
                val inputStream = body.byteStream()
                val apkFile = File(context.cacheDir, "update.apk")
                
                apkFile.outputStream().use { output ->
                    val buffer = ByteArray(8192)
                    var bytesRead: Int
                    var totalBytesRead = 0L
                    while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                        output.write(buffer, 0, bytesRead)
                        totalBytesRead += bytesRead
                        if (contentLength > 0) {
                            val progress = (totalBytesRead * 100 / contentLength).toInt()
                            onProgress(progress)
                        }
                    }
                }
                return@withContext apkFile
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return@withContext null
    }

    fun installApk(context: Context, apkFile: File) {
        try {
            val apkUri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
