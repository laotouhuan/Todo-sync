package com.todo.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.todo.app.data.ConfigManager
import com.todo.app.ui.theme.TodoAppTheme
import com.todo.app.ui.view.ListView
import com.todo.app.ui.view.SettingsView
import com.todo.app.ui.view.StatsView
import com.todo.app.ui.viewmodel.TodoViewModel
import com.todo.app.ui.viewmodel.TodoViewModelFactory
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import com.todo.app.data.model.SyncPhase

class MainActivity : ComponentActivity() {

    private val repository by lazy { TodoApplication.instance.repository }
    private val configManager by lazy { ConfigManager(applicationContext) }
    private val viewModel: TodoViewModel by viewModels {
        TodoViewModelFactory(repository, configManager)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        com.todo.app.notification.PermissionHelper.checkAndRequestNotificationPermission(this)
        requestBatteryOptimizationIfNeeded()
        viewModel.rescheduleAlarms()

        setContent {
            TodoAppTheme {
                TodoApp(viewModel)
            }
        }

        startMidnightRefreshJob()
    }

    /**
     * 首次启动时主动弹出系统「忽略电池优化」授权对话框。
     * 仅在尚未授权时弹出，避免重复打扰用户。
     */
    private fun requestBatteryOptimizationIfNeeded() {
        if (!com.todo.app.notification.PermissionHelper.checkBatteryOptimizationPermission(this)) {
            com.todo.app.notification.PermissionHelper.requestBatteryOptimizationPermission(this)
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refreshTodayDate()
    }

    private fun startMidnightRefreshJob() {
        lifecycleScope.launch {
            while (isActive) {
                val now = java.time.LocalDateTime.now()
                val nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay()
                val delayMs = java.time.Duration.between(now, nextMidnight).toMillis() + 100
                delay(maxOf(delayMs, 1000))
                if (!viewModel.isEditingDialogShowing.value) {
                    viewModel.refreshTodayDate()
                } else {
                    // ViewModel handles pendingMidnightRefresh internally
                }
            }
        }
    }
}

sealed class Screen(val route: String, val title: String, val icon: ImageVector) {
    data object List : Screen("list", "列表", Icons.Filled.List)
    data object Stats : Screen("stats", "统计", Icons.Filled.DateRange)
    data object Settings : Screen("settings", "设置", Icons.Filled.Settings)

    companion object {
        // 首次访问子页面时，父类初始化不能提前缓存尚未完成初始化的单例。
        val items: kotlin.collections.List<Screen>
            get() = listOf(List, Stats, Settings)
    }
}

@Composable
fun TodoApp(viewModel: TodoViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(viewModel) {
        launch {
            viewModel.repositoryEvents.collect { event ->
                val message = when (event) {
                    is com.todo.app.data.repository.UiEvent.ShowMessage -> event.message
                    is com.todo.app.data.repository.UiEvent.ShowError -> event.error
                }
                android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_LONG).show()
            }
        }
        launch {
            viewModel.uiEvent.collect { message ->
                android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route
    val insightsNavigation = remember { com.todo.app.ui.view.InsightsNavigation() }
    androidx.activity.compose.BackHandler(enabled = currentRoute == Screen.Stats.route) {
        insightsNavigation.request { navController.popBackStack() }
    }
    val discardedShortTimers by viewModel.discardedShortTimers.collectAsState()

    Scaffold(
        topBar = {
            Column {
                AppTopBar(viewModel = viewModel, currentRoute = currentRoute, requestNavigation = insightsNavigation::request)
                com.todo.app.ui.view.CollaborationSubmissionBanner(viewModel)
                com.todo.app.ui.view.LearningBanner(viewModel)
            }
        },
        bottomBar = {
            NavigationBar(
                containerColor = NavigationBarDefaults.containerColor
            ) {
                val currentDestination = navBackStackEntry?.destination
                Screen.items.forEach { screen ->
                    NavigationBarItem(
                        icon = { Icon(screen.icon, contentDescription = null) },
                        label = { Text(screen.title) },
                        selected = currentDestination?.hierarchy?.any { it.route == screen.route } == true,
                        onClick = {
                            insightsNavigation.request {
                                navController.navigate(screen.route) {
                                    popUpTo(navController.graph.findStartDestination().id) {
                                        saveState = true
                                    }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(navController, startDestination = Screen.List.route, Modifier.padding(innerPadding)) {
            composable(Screen.List.route) { ListView(viewModel) }
            composable(Screen.Stats.route) { StatsView(viewModel, insightsNavigation) }
            composable(Screen.Settings.route) { SettingsView(viewModel) }
        }
    }
    if (discardedShortTimers > 0) {
        AlertDialog(
            onDismissRequest = viewModel::dismissShortTimerNotice,
            title = { Text("计时过短") },
            text = { Text(if (discardedShortTimers == 1) com.todo.app.data.model.Learning.SHORT_TIME_ENTRY_MESSAGE
                else "${discardedShortTimers} 条计时未超过 30 秒，不保存为记录。") },
            confirmButton = { TextButton(onClick = viewModel::dismissShortTimerNotice) { Text("知道了") } }
        )
    }
}

@Composable
fun AppTopBar(viewModel: TodoViewModel, currentRoute: String?, requestNavigation: (() -> Unit) -> Unit = { it() }) {
    val activeSource by viewModel.activeSource.collectAsState()
    val collabs by viewModel.collaborations.collectAsState()
    val syncOutcome by viewModel.syncOutcome.collectAsState()
    val planningSync by viewModel.planningSync.collectAsState()
    val personalSyncRunning by viewModel.personalSyncRunning.collectAsState()
    val personalSyncCompletedAt by viewModel.personalSyncCompletedAt.collectAsState()
    val showSearchBar by viewModel.showSearchBar.collectAsState()
    var showSourceMenu by remember { mutableStateOf(false) }

    val isReadOnly = activeSource is TodoViewModel.ActiveSource.Collaboration
    val target = when (val source = activeSource) {
        is TodoViewModel.ActiveSource.Personal -> "personal"
        is TodoViewModel.ActiveSource.Collaboration -> "collaboration:${source.collab.id}:${source.collab.updatedAt}"
    }
    val isLoading = syncOutcome.target == target && syncOutcome.phase == SyncPhase.RUNNING || !isReadOnly && personalSyncRunning
    val planningPhase = planningSync?.takeIf { !isReadOnly && it.first == viewModel.configManager.personalPlanningTarget() }?.second
    val planningPending = planningPhase == SyncPhase.RUNNING
    val syncFailed = syncOutcome.target == target && syncOutcome.isFailure || planningPhase == SyncPhase.FAILED
    val showProgress = !syncFailed && (isLoading || planningPending)
    var showSuccess by remember(syncOutcome, activeSource) { mutableStateOf(false) }

    LaunchedEffect(syncOutcome, activeSource, personalSyncCompletedAt, personalSyncRunning, planningPhase) {
        val completedAt = if (isReadOnly) syncOutcome.completedAt else personalSyncCompletedAt
        showSuccess = !isLoading && !syncFailed && !planningPending &&
            (if (isReadOnly) syncOutcome.showsSuccess(target) else completedAt > 0 && System.currentTimeMillis() - completedAt < 1500)
        if (showSuccess) {
            delay((completedAt + 1500 - System.currentTimeMillis()).coerceAtLeast(0))
            showSuccess = false
        }
    }

    Row(
        modifier = Modifier
            .statusBarsPadding()
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Box(modifier = Modifier.weight(1f)) {
            if (currentRoute == "settings") {
                Text(
                    text = "系统设置",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
            } else {
                Row(
                    modifier = Modifier.clickable { showSourceMenu = true },
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    val title = when (val src = activeSource) {
                        is TodoViewModel.ActiveSource.Personal -> "我的待办"
                        is TodoViewModel.ActiveSource.Collaboration -> src.collab.name
                    }
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Spacer(Modifier.width(4.dp))
                    Icon(
                        imageVector = Icons.Filled.ArrowDropDown,
                        contentDescription = "切换清单",
                        tint = MaterialTheme.colorScheme.primary
                    )

                    if (isReadOnly) {
                        Spacer(Modifier.width(8.dp))
                        Surface(
                            shape = RoundedCornerShape(4.dp),
                            color = MaterialTheme.colorScheme.errorContainer
                        ) {
                            Text(
                                text = "只读清单",
                                style = MaterialTheme.typography.bodySmall.copy(fontSize = 10.sp),
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                            )
                        }
                    }
                }

                DropdownMenu(
                    expanded = showSourceMenu,
                    onDismissRequest = { showSourceMenu = false }
                ) {
                    DropdownMenuItem(
                        text = { Text("我的待办") },
                        onClick = {
                            showSourceMenu = false
                            requestNavigation { viewModel.switchToPersonal() }
                        }
                    )
                    collabs.forEach { collab ->
                        DropdownMenuItem(
                            text = { Text(collab.name) },
                            onClick = {
                                showSourceMenu = false
                                requestNavigation { viewModel.switchToCollaboration(collab) }
                            }
                        )
                    }
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            com.todo.app.ui.view.LearningStartButton(viewModel)
            // Show Search toggle button ONLY on List screen
            if (currentRoute == "list") {
                IconButton(onClick = {
                    viewModel.setShowSearchBar(!showSearchBar)
                }) {
                    Icon(
                        imageVector = if (showSearchBar) Icons.Filled.Close else Icons.Filled.Search,
                        contentDescription = "搜索",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
            }
            if (syncFailed) Text("同步失败", color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall)
            IconButton(
                onClick = {
                    if (showSuccess && !syncFailed && !planningPending) return@IconButton
                    val source = activeSource
                    if (source is TodoViewModel.ActiveSource.Collaboration) {
                        viewModel.loadCollabData(source.collab)
                    } else {
                        viewModel.syncWithCloud()
                    }
                },
                enabled = !isLoading
            ) {
                if (showProgress) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                } else if (syncFailed) {
                    Icon(Icons.Filled.Warning, contentDescription = "${syncOutcome.error?.message ?: "同步失败"}，点击重试",
                        tint = MaterialTheme.colorScheme.error)
                } else if (showSuccess) {
                    Icon(
                        imageVector = Icons.Filled.Check,
                        contentDescription = "同步成功",
                        tint = androidx.compose.ui.graphics.Color(0xFF10B981)
                    )
                } else {
                    Icon(
                        imageVector = Icons.Filled.Refresh,
                        contentDescription = "同步",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
            }
        }
    }
}
