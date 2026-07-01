package com.todo.app.data

import android.content.Context
import android.content.SharedPreferences

class ConfigManager(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("todo_prefs", Context.MODE_PRIVATE)

    var webDavUrl: String
        get() = prefs.getString("webdav_url", "https://dav.jianguoyun.com/dav/") ?: "https://dav.jianguoyun.com/dav/"
        set(value) = prefs.edit().putString("webdav_url", value).apply()

    var username: String
        get() = prefs.getString("username", "") ?: ""
        set(value) = prefs.edit().putString("username", value).apply()

    var appPassword: String
        get() = prefs.getString("app_password", "") ?: ""
        set(value) = prefs.edit().putString("app_password", value).apply()

    var filePath: String
        get() = prefs.getString("file_path", "我的坚果云/to-do/todo_data.json") ?: "我的坚果云/to-do/todo_data.json"
        set(value) = prefs.edit().putString("file_path", value).apply()




    fun isConfigured(): Boolean {
        return username.isNotEmpty() && appPassword.isNotEmpty()
    }
}
