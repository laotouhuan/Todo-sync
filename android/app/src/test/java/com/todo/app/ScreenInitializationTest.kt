package com.todo.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class ScreenInitializationTest {
    @Test fun statsRouteBeforeNavigationItemsKeepsEveryScreenInitialized() {
        // 启动时返回键处理器先读取 Stats.route；隔离类加载以复现首次启动顺序。
        assertNavigationItems("Stats", "stats")
    }

    @Test fun listRouteBeforeNavigationItemsKeepsEveryScreenInitialized() {
        assertNavigationItems("List", "list")
    }

    @Test fun settingsRouteBeforeNavigationItemsKeepsEveryScreenInitialized() {
        assertNavigationItems("Settings", "settings")
    }

    @Test fun navigationItemsCanBeTheFirstAccess() {
        assertNavigationItems(null, null)
    }

    private fun assertNavigationItems(firstScreen: String?, expectedRoute: String?) {
        val parent = javaClass.classLoader!!
        val loader = object : ClassLoader(parent) {
            override fun loadClass(name: String, resolve: Boolean): Class<*> {
                if (name != "com.todo.app.Screen" && !name.startsWith("com.todo.app.Screen$")) {
                    return super.loadClass(name, resolve)
                }
                synchronized(this) {
                    val type = findLoadedClass(name) ?: run {
                        val bytes = parent.getResourceAsStream(name.replace('.', '/') + ".class")!!.use { it.readBytes() }
                        defineClass(name, bytes, 0, bytes.size)
                    }
                    if (resolve) resolveClass(type)
                    return type
                }
            }
        }
        val first = firstScreen?.let { loader.loadClass("com.todo.app.Screen\$$it").getField("INSTANCE").get(null) }
        val screen = loader.loadClass("com.todo.app.Screen")
        if (first != null) assertEquals(expectedRoute, screen.getMethod("getRoute").invoke(first))
        val companion = screen.getField("Companion").get(null)
        val items = companion.javaClass.getMethod("getItems").invoke(companion) as List<*>
        items.forEach { assertNotNull("导航条不能包含尚未初始化的页面", it) }
        assertEquals(listOf("list", "stats", "settings"), items.map { screen.getMethod("getRoute").invoke(it) })
    }
}
