package com.todo.app

import android.app.Application
import com.todo.app.data.ConfigManager
import com.todo.app.data.repository.TodoRepository

class TodoApplication : Application() {
    // 实例化全局唯一的 TodoRepository 与 ConfigManager
    val repository: TodoRepository by lazy { TodoRepository(this) }
    val configManager: ConfigManager by lazy { ConfigManager(this) }

    override fun onCreate() {
        super.onCreate()
        instance = this
        com.todo.app.notification.NotificationHelper.createChannels(this)
    }

    companion object {
        lateinit var instance: TodoApplication
            private set
    }
}
