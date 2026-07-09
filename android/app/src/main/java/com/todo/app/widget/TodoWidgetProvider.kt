package com.todo.app.widget

import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

abstract class BaseTodoWidgetProvider(private val widget: GlanceAppWidget) : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget get() = widget
}

class TodoCompactWidgetProvider : BaseTodoWidgetProvider(TodoCompactWidget())

class TodoNormalWidgetProvider : BaseTodoWidgetProvider(TodoNormalWidget())
