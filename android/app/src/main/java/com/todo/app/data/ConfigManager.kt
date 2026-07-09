package com.todo.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class ConfigManager(context: Context) {

    companion object {
        const val DEFAULT_WEBDAV_URL = "https://dav.jianguoyun.com/dav/"
        const val DEFAULT_FILE_PATH = "我的坚果云/to-do/todo_data.json"
    }

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "todo_encrypted_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    var webDavUrl: String
        get() = prefs.getString("webdav_url", DEFAULT_WEBDAV_URL) ?: DEFAULT_WEBDAV_URL
        set(value) = prefs.edit().putString("webdav_url", value).apply()

    var username: String
        get() = prefs.getString("username", "") ?: ""
        set(value) = prefs.edit().putString("username", value).apply()

    var appPassword: String
        get() = prefs.getString("app_password", "") ?: ""
        set(value) = prefs.edit().putString("app_password", value).apply()

    var filePath: String
        get() = prefs.getString("file_path", DEFAULT_FILE_PATH) ?: DEFAULT_FILE_PATH
        set(value) = prefs.edit().putString("file_path", value).apply()

    fun isConfigured(): Boolean {
        return username.isNotEmpty() && appPassword.isNotEmpty()
    }
}
