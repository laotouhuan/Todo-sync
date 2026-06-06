package com.todo.app

import android.app.Application
import com.todo.app.data.repository.TodoRepository

class TodoApplication : Application() {
    // 实例化全局唯一的 TodoRepository
    val repository: TodoRepository by lazy { TodoRepository(this) }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: TodoApplication
            private set
    }
}
