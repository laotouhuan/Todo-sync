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

class MainActivity : ComponentActivity() {

    private val repository by lazy { TodoApplication.instance.repository }
    private val configManager by lazy { ConfigManager(applicationContext) }
    private val viewModel: TodoViewModel by viewModels {
        TodoViewModelFactory(repository, configManager)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            TodoAppTheme {
                TodoApp(viewModel)
            }
        }

        startMidnightRefreshJob()
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
        val items = listOf(List, Stats, Settings)
    }
}

@Composable
fun TodoApp(viewModel: TodoViewModel) {
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route

    Scaffold(
        topBar = {
            AppTopBar(viewModel = viewModel, currentRoute = currentRoute)
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
                            navController.navigate(screen.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(navController, startDestination = Screen.List.route, Modifier.padding(innerPadding)) {
            composable(Screen.List.route) { ListView(viewModel) }
            composable(Screen.Stats.route) { StatsView(viewModel) }
            composable(Screen.Settings.route) { SettingsView(viewModel) }
        }
    }
}

@Composable
fun AppTopBar(viewModel: TodoViewModel, currentRoute: String?) {
    val activeSource by viewModel.activeSource.collectAsState()
    val collabs by viewModel.collaborations.collectAsState()
    val collabLoading by viewModel.collabLoading.collectAsState()
    val isSyncing by viewModel.isSyncing.collectAsState()
    val showSearchBar by viewModel.showSearchBar.collectAsState()
    var showSourceMenu by remember { mutableStateOf(false) }

    val isReadOnly = activeSource is TodoViewModel.ActiveSource.Collaboration
    val isLoading = if (activeSource is TodoViewModel.ActiveSource.Personal) isSyncing else collabLoading

    var wasLoading by remember { mutableStateOf(false) }
    var showSuccess by remember { mutableStateOf(false) }

    LaunchedEffect(isLoading) {
        if (isLoading) {
            wasLoading = true
            showSuccess = false
        } else if (wasLoading) {
            showSuccess = true
            wasLoading = false
            kotlinx.coroutines.delay(1500)
            showSuccess = false
        }
    }

    Row(
        modifier = Modifier
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
                            viewModel.switchToPersonal()
                            showSourceMenu = false
                        }
                    )
                    collabs.forEach { collab ->
                        DropdownMenuItem(
                            text = { Text(collab.name) },
                            onClick = {
                                viewModel.switchToCollaboration(collab)
                                showSourceMenu = false
                            }
                        )
                    }
                }
            }
        }

        if (currentRoute != "settings") {
            Row(verticalAlignment = Alignment.CenterVertically) {
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
                IconButton(
                    onClick = {
                        if (showSuccess) return@IconButton
                        val source = activeSource
                        if (source is TodoViewModel.ActiveSource.Collaboration) {
                            viewModel.loadCollabData(source.collab)
                        } else {
                            viewModel.syncWithCloud()
                        }
                    },
                    enabled = true
                ) {
                    if (isLoading) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
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
}
