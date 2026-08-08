package com.todo.app.notification

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

object PermissionHelper {
    const val REQ_NOTIFICATION = 1001
    private const val TAG = "PermissionHelper"

    fun isNotificationPermissionGranted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    fun checkAndRequestNotificationPermission(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!isNotificationPermissionGranted(activity)) {
                ActivityCompat.requestPermissions(
                    activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATION
                )
                return false
            }
        }
        return true
    }

    fun openNotificationSettings(context: Context) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                }
                context.startActivity(intent)
            } else {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
                context.startActivity(intent)
            }
        } catch (_: Exception) {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            context.startActivity(intent)
        }
    }

    fun checkExactAlarmPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            return am.canScheduleExactAlarms()
        }
        return true
    }

    fun requestExactAlarmPermission(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
                context.startActivity(intent)
            } catch (_: Exception) {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
                context.startActivity(intent)
            }
        }
    }

    fun checkBatteryOptimizationPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(context.packageName)
        }
        return true
    }

    /**
     * 请求系统级"忽略电池优化"授权。
     * 与 Manifest 中声明权限不同，这里会弹出真正的系统授权对话框。
     */
    fun requestBatteryOptimizationPermission(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            } catch (_: Exception) {
                try {
                    val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                } catch (_: Exception) {}
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    // 国产 ROM 自启动 / 后台管理深度链接
    // ─────────────────────────────────────────────────────────

    /**
     * 检测当前手机品牌。
     * 返回小写规范化字符串，如 "huawei", "xiaomi", "oppo", "vivo", "samsung", "oneplus" 等。
     */
    fun getManufacturer(): String = Build.MANUFACTURER?.lowercase()?.trim() ?: ""

    /**
     * 根据品牌获取用于权限设置的显示名称（用于 UI 提示文案）。
     */
    fun getManufacturerLabel(): String {
        return when {
            isHuawei() -> "华为/Honor"
            isXiaomi() -> "小米/Redmi"
            isOppo()   -> "OPPO/一加/真我"
            isVivo()   -> "vivo/iQOO"
            isSamsung() -> "三星"
            else -> ""
        }
    }

    fun isHuawei()  = getManufacturer().let { it.contains("huawei") || it.contains("honor") }
    fun isXiaomi()  = getManufacturer().let { it.contains("xiaomi") || it.contains("redmi") || Build.BRAND?.lowercase()?.contains("redmi") == true }
    fun isOppo()    = getManufacturer().let { it.contains("oppo") || it.contains("oneplus") || it.contains("realme") }
    fun isVivo()    = getManufacturer().let { it.contains("vivo") }
    fun isSamsung() = getManufacturer().let { it.contains("samsung") }

    /**
     * 是否为已知需要额外操作的国产 ROM。
     */
    fun isChineseRom() = isHuawei() || isXiaomi() || isOppo() || isVivo()

    /**
     * 尝试打开当前品牌的「自启动管理」或「后台应用管理」设置页面。
     * 按照优先顺序逐一尝试 ComponentName，均失败则回退到通用应用详情页。
     */
    fun openAutoStartSettings(context: Context) {
        val intents: List<Intent> = when {
            isHuawei() -> listOf(
                // HarmonyOS / EMUI 自启动管理
                makeComponentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.startempoint.ui.StartEntryActivity"),
                // 旧版 EMUI
                makeComponentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
                // 电池优化白名单
                makeComponentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.power.ui.HwPowerManagerActivity")
            )
            isXiaomi() -> listOf(
                // MIUI 自启动管理
                makeComponentIntent("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                // 新版 MIUI
                makeComponentIntent("com.xiaomi.permit", "com.xiaomi.permit.autostart.AutoStartManagementActivity"),
                // MIUI 安全中心
                makeComponentIntent("com.miui.securitycenter", "com.miui.securitycenter.MainActivity")
            )
            isOppo() -> listOf(
                // ColorOS 自启动
                makeComponentIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                makeComponentIntent("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
                // 新版 ColorOS 权限管理
                makeComponentIntent("com.coloros.securitypermission", "com.coloros.securitypermission.permission.PermissionManagerActivity"),
                // 一加
                makeComponentIntent("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")
            )
            isVivo() -> listOf(
                // FuntouchOS / OriginOS 自启动
                makeComponentIntent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
                makeComponentIntent("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                makeComponentIntent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")
            )
            isSamsung() -> listOf(
                // Samsung 设备维护 → 电池
                makeComponentIntent("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
                makeComponentIntent("com.samsung.android.sm.policy", "com.samsung.android.sm.policy.battery.SleepingAppListActivity")
            )
            else -> emptyList()
        }

        // 依次尝试，找到第一个可用的
        for (intent in intents) {
            if (tryStartActivity(context, intent)) {
                Log.d(TAG, "成功打开自启动设置: ${intent.component}")
                return
            }
        }

        // 全部失败，回退到系统应用详情页
        Log.w(TAG, "未找到品牌自启动设置页，回退到应用详情")
        try {
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(fallback)
        } catch (_: Exception) {}
    }

    private fun makeComponentIntent(pkg: String, cls: String): Intent {
        return Intent().apply {
            component = ComponentName(pkg, cls)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    private fun tryStartActivity(context: Context, intent: Intent): Boolean {
        return try {
            // 先检查 Activity 是否存在
            val resolved = context.packageManager.resolveActivity(intent, 0)
            if (resolved != null) {
                context.startActivity(intent)
                true
            } else {
                false
            }
        } catch (_: Exception) {
            false
        }
    }
}
