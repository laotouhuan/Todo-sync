package com.todo.app.utils

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

data class UpdateInfo(
    val version: String,
    val notes: String,
    val apkUrl: String,
    val sha256: String? = null
)

sealed interface UpdateResult {
    data class NewVersion(val info: UpdateInfo) : UpdateResult
    object LatestVersion : UpdateResult
    data class Error(val message: String) : UpdateResult
}

object AppUpdater {
    private const val TAG = "AppUpdater"

    private val downloadClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val client = OkHttpClient()

    suspend fun checkForUpdates(currentVersion: String): UpdateResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("https://github.com/laotouhuan/Todo-sync/releases/latest/download/latest.json")
            .build()
        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return@withContext UpdateResult.Error("HTTP 状态码: ${response.code}")
                }
                val bodyStr = response.body?.string() ?: return@withContext UpdateResult.Error("接口返回数据为空")
                val json = JSONObject(bodyStr)
                val latestVersion = json.getString("version")
                val notes = json.optString("notes", "")
                val sha256 = json.optString("sha256", "").takeIf { it.isNotEmpty() }
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
                    return@withContext UpdateResult.NewVersion(UpdateInfo(latestVersion, notes, apkUrl, sha256))
                } else {
                    return@withContext UpdateResult.LatestVersion
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "checkForUpdates failed", e)
            return@withContext UpdateResult.Error(e.message ?: e.javaClass.simpleName)
        }
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

    /**
     * Verify SHA-256 hash of a file matches the expected value.
     * @param file The file to verify
     * @param expected The expected SHA-256 hex string
     * @return true if hash matches, false otherwise
     */
    fun verifySha256(file: File, expected: String): Boolean {
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(8192)
                var bytesRead: Int
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    digest.update(buffer, 0, bytesRead)
                }
            }
            val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
            actualHash.equals(expected, ignoreCase = true)
        } catch (e: Exception) {
            Log.e(TAG, "SHA-256 verification failed", e)
            false
        }
    }

    suspend fun downloadApk(
        context: Context,
        url: String,
        onProgress: (Int) -> Unit,
        expectedSha256: String? = null
    ): File? = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).build()
        try {
            downloadClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val body = response.body ?: return@withContext null
                val contentLength = body.contentLength()
                val inputStream = body.byteStream()

                // Use version-based unique filename to avoid cache overwrite issues
                val hash = url.hashCode().toString(16)
                val apkFile = File(context.cacheDir, "update_${hash}.apk")

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

                // Verify integrity if expected SHA-256 is provided
                if (!expectedSha256.isNullOrEmpty()) {
                    if (!verifySha256(apkFile, expectedSha256)) {
                        Log.e(TAG, "APK SHA-256 verification failed")
                        apkFile.delete()
                        return@withContext null
                    }
                }

                return@withContext apkFile
            }
        } catch (e: Exception) {
            Log.e(TAG, "downloadApk failed", e)
        }
        return@withContext null
    }

    /**
     * Launch the APK installer.
     * @return true if the install intent was started successfully
     */
    fun installApk(context: Context, apkFile: File): Boolean {
        return try {
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
            true
        } catch (e: Exception) {
            Log.e(TAG, "installApk failed", e)
            false
        }
    }
}
