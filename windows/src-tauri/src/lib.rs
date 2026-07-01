mod todo_store;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, AppHandle, Emitter,
};
use tauri_plugin_global_shortcut::ShortcutState;
use notify::{Watcher, RecursiveMode, Event};
use std::thread;

/// 切换主窗口的显示/隐藏状态
fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);
        if is_visible && is_focused {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
fn start_drag(window: tauri::Window) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn set_always_on_top(window: tauri::Window, always_on_top: bool) -> Result<(), String> {
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

fn watch_file(app: AppHandle) {
    let app_clone = app.clone();
    
    thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx).unwrap();
        
        let mut current_path = todo_store::get_data_path(&app_clone).unwrap_or_default();
        if let Some(parent) = current_path.parent() {
            let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
        }

        loop {
            if let Ok(Ok(Event { paths, .. })) = rx.recv_timeout(std::time::Duration::from_millis(500)) {
                if paths.contains(&current_path) {
                    use tauri::Emitter;
                    let _ = app_clone.emit("todo_data_changed", ());
                }
            }
            
            let new_path = todo_store::get_data_path(&app_clone).unwrap_or_default();
            if new_path != current_path {
                if let Some(parent) = current_path.parent() {
                    let _ = watcher.unwatch(parent);
                }
                current_path = new_path;
                if let Some(parent) = current_path.parent() {
                    let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
                }
                use tauri::Emitter;
                let _ = app_clone.emit("todo_data_changed", ());
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+shift+space", "ctrl+shift+t"])
                .unwrap()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        use tauri_plugin_global_shortcut::{Code, Modifiers};
                        if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space) {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                                let _ = app.emit("trigger-quick-add", "show");
                            }
                        } else if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyT) {
                            toggle_window(app);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
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
            todo_store::fetch_from_cloud
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
