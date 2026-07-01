package com.todo.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
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
    private lateinit var viewModel: TodoViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        
        val repository = TodoApplication.instance.repository
        val configManager = ConfigManager(applicationContext)

        setContent {
            val vm: TodoViewModel = viewModel(
                factory = TodoViewModelFactory(repository, configManager)
            )
            viewModel = vm
            TodoAppTheme {
                TodoApp(vm)
            }
        }

        startMidnightRefreshJob()
    }

    override fun onResume() {
        super.onResume()
        if (::viewModel.isInitialized) {
            viewModel.refreshTodayDate()
        }
    }

    private fun startMidnightRefreshJob() {
        lifecycleScope.launch {
            while (isActive) {
                val now = java.time.LocalDateTime.now()
                val nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay()
                val delayMs = java.time.Duration.between(now, nextMidnight).toMillis() + 100
                delay(delayMs)
                if (::viewModel.isInitialized) {
                    if (!viewModel.isEditingDialogShowing.value) {
                        viewModel.refreshTodayDate()
                    } else {
                        viewModel.pendingMidnightRefresh = true
                    }
                }
            }
        }
    }
}

sealed class Screen(val route: String, val title: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    object List : Screen("list", "列表", Icons.Filled.List)
    object Stats : Screen("stats", "统计", Icons.Filled.DateRange)
    object Settings : Screen("settings", "设置", Icons.Filled.Settings)
}

val items = listOf(Screen.List, Screen.Stats, Screen.Settings)

@Composable
fun TodoApp(viewModel: TodoViewModel) {
    val navController = rememberNavController()
    Scaffold(
        bottomBar = {
            NavigationBar(
                containerColor = NavigationBarDefaults.containerColor
            ) {
                val navBackStackEntry by navController.currentBackStackEntryAsState()
                val currentDestination = navBackStackEntry?.destination
                items.forEach { screen ->
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
