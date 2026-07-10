mod todo_store;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, AppHandle, Emitter,
};
use tauri_plugin_global_shortcut::ShortcutState;
use notify::{Watcher, RecursiveMode, Event};
use std::time::Duration;
use std::thread;

// 硬编码快捷键常量
const SHORTCUTS: &[&str] = &["ctrl+shift+space", "ctrl+shift+t"];

/// 文件轮询检查间隔（毫秒）
const FILE_POLL_INTERVAL_MS: u64 = 5000;

/// WebDAV 操作使用的共享 HTTP 客户端（15 秒超时）
pub struct WebdavHttpClient(pub reqwest::Client);

/// GitHub API 操作使用的共享 HTTP 客户端（10 秒超时）
pub struct GithubHttpClient(pub reqwest::Client);

/// 创建共享的 reqwest::Client（WebDAV 操作使用）
fn create_shared_http_client() -> WebdavHttpClient {
    WebdavHttpClient(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("Failed to create HTTP client")
    )
}

/// 创建用于 GitHub API 的 reqwest::Client（较短超时）
fn create_github_http_client() -> GithubHttpClient {
    GithubHttpClient(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to create GitHub HTTP client")
    )
}

/// 切换主窗口的显示/隐藏状态
fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);
        if is_visible && is_focused {
            if let Err(e) = window.hide() {
                log::warn!("Failed to hide window: {e}");
            }
        } else {
            if let Err(e) = window.show() {
                log::warn!("Failed to show window: {e}");
            }
            if let Err(e) = window.unminimize() {
                log::warn!("Failed to unminimize window: {e}");
            }
            if let Err(e) = window.set_focus() {
                log::warn!("Failed to set focus on window: {e}");
            }
        }
    }
}

#[tauri::command]
fn start_drag(window: tauri::WebviewWindow) {
    if let Err(e) = window.start_dragging() {
        log::warn!("Failed to start dragging: {e}");
    }
}

#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, always_on_top: bool) -> Result<(), String> {
    window.set_always_on_top(always_on_top).map_err(|e| e.to_string())
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 监控文件变化，使用 5 秒轮询作为 fallback
fn watch_file(app: AppHandle) {
    let app_clone = app.clone();

    thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                log::error!("Failed to create file watcher: {e}");
                return;
            }
        };

        let mut current_path = todo_store::get_data_path(&app_clone).unwrap_or_default();
        if let Some(parent) = current_path.parent() {
            if let Err(e) = watcher.watch(parent, RecursiveMode::NonRecursive) {
                log::warn!("Failed to watch directory {:?}: {e}", parent);
            }
        }

        let mut last_path_check = std::time::Instant::now();
        let poll_interval = Duration::from_millis(FILE_POLL_INTERVAL_MS);

        loop {
            // 短超时接收文件事件，配合外部计时器实现 5 秒轮询
            if let Ok(Ok(Event { paths, .. })) = rx.recv_timeout(Duration::from_millis(500)) {
                if paths.contains(&current_path) {
                    let _ = app_clone.emit("todo_data_changed", ());
                }
            }

            // 检查路径是否变化（每 5 秒轮询）
            if last_path_check.elapsed() >= poll_interval {
                last_path_check = std::time::Instant::now();
                let new_path = todo_store::get_data_path(&app_clone).unwrap_or_default();
                if new_path != current_path {
                    if let Some(parent) = current_path.parent() {
                        if let Err(e) = watcher.unwatch(parent) {
                            log::warn!("Failed to unwatch {:?}: {e}", parent);
                        }
                    }
                    current_path = new_path;
                    if let Some(parent) = current_path.parent() {
                        if let Err(e) = watcher.watch(parent, RecursiveMode::NonRecursive) {
                            log::warn!("Failed to watch {:?}: {e}", parent);
                        }
                    }
                    let _ = app_clone.emit("todo_data_changed", ());
                }
            }
        }
    });
}

/// 设置系统托盘
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let toggle_i = MenuItem::with_id(app, "toggle", "Show/Hide", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                app.exit(0);
            }
            "toggle" => {
                toggle_window(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .icon(app.default_window_icon().unwrap().clone())
        .build(app)?;

    Ok(())
}

/// 设置全局快捷键
fn setup_shortcuts() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts(SHORTCUTS.iter().copied())
        .expect("Failed to register shortcuts")
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                use tauri_plugin_global_shortcut::{Code, Modifiers};

                if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space) {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(e) = window.show() {
                            log::warn!("Failed to show window: {e}");
                        }
                        if let Err(e) = window.unminimize() {
                            log::warn!("Failed to unminimize window: {e}");
                        }
                        if let Err(e) = window.set_focus() {
                            log::warn!("Failed to set focus on window: {e}");
                        }
                        let _ = app.emit("trigger-quick-add", "show");
                    }
                } else if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyT) {
                    toggle_window(app);
                }
            }
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    log::info!("Starting Todo application");

    let webdav_client = create_shared_http_client();
    let github_client = create_github_http_client();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(setup_shortcuts())
        .manage(webdav_client)
        .manage(github_client)
        .setup(|app| {
            setup_tray(app)?;

            watch_file(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            start_drag,
            set_always_on_top,
            restart_app,
            todo_store::pick_sync_folder,
            todo_store::get_sync_path,
            todo_store::set_sync_path,
            todo_store::read_todo_data,
            todo_store::write_todo_data,
            todo_store::list_backups,
            todo_store::restore_backup,
            todo_store::get_app_config,
            todo_store::save_app_config,
            todo_store::sync_to_cloud,
            todo_store::fetch_from_cloud,
            todo_store::get_latest_release
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
