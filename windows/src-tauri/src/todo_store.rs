use std::fs::{self, OpenOptions, File};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;
use std::time::Duration;
use fs2::FileExt;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    pub sync_mode: Option<String>, // "local" or "webdav"
    pub sync_path: Option<String>,
    pub webdav_url: Option<String>,
    pub webdav_username: Option<String>,
    pub webdav_password: Option<String>,
    pub webdav_filepath: Option<String>,
}

pub fn get_config_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap_or_default();
    let _ = fs::create_dir_all(&path);
    path.join("config.json")
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let path = get_config_path(app);
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = get_config_path(app);
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_config(app: AppHandle) -> AppConfig {
    load_config(&app)
}

#[tauri::command]
pub fn save_app_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    save_config(&app, &config)
}

/// WebDAV 连接信息，包含认证凭据和构建好的目标 URL
struct WebDavConn {
    user: String,
    pass: String,
    target: String,
}

/// 从配置中构建 WebDAV 连接信息
fn build_webdav_conn(app: &AppHandle) -> Result<WebDavConn, String> {
    let config = load_config(app);
    if config.sync_mode.as_deref() != Some("webdav") {
        return Err("Not in WebDAV mode".to_string());
    }
    let url = config.webdav_url.as_deref().unwrap_or("https://dav.jianguoyun.com/dav/");
    let user = config.webdav_username.as_deref().unwrap_or("").to_string();
    let pass = config.webdav_password.as_deref().unwrap_or("").to_string();
    let file_path = config.webdav_filepath.as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("我的坚果云/to-do/todo_data.json");

    let encoded_path = file_path.split('/').map(|s| {
        if s.is_empty() { String::new() } else { urlencoding::encode(s).into_owned() }
    }).collect::<Vec<_>>().join("/");

    let target = if url.ends_with('/') { format!("{}{}", url, encoded_path) } else { format!("{}/{}", url, encoded_path) };

    Ok(WebDavConn { user, pass, target })
}

#[tauri::command]
pub async fn sync_to_cloud(app: AppHandle, data: String) -> Result<(), String> {
    let conn = build_webdav_conn(&app)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;

    let resp = client.put(&conn.target)
        .basic_auth(&conn.user, Some(&conn.pass))
        .header("Content-Type", "application/json; charset=utf-8")
        .body(data)
        .send().await.map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("WebDAV PUT Error: {}", resp.status()))
    }
}

#[tauri::command]
pub async fn fetch_from_cloud(app: AppHandle) -> Result<String, String> {
    let conn = build_webdav_conn(&app)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;

    let resp = client.get(&conn.target)
        .basic_auth(&conn.user, Some(&conn.pass))
        .send().await.map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        resp.text().await.map_err(|e| e.to_string())
    } else {
        Err(format!("WebDAV GET Error: {}", resp.status()))
    }
}

#[tauri::command]
pub async fn pick_sync_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择坚果云同步目录 (Nutstore Sync Folder)")
        .pick_folder(move |folder_path| {
            if let Some(path) = folder_path {
                tx.send(Some(path.to_string())).unwrap();
            } else {
                tx.send(None).unwrap();
            }
        });
    Ok(rx.recv().unwrap_or(None))
}

#[tauri::command]
pub fn get_sync_path(app: AppHandle) -> Option<String> {
    load_config(&app).sync_path
}

#[tauri::command]
pub fn set_sync_path(app: AppHandle, new_path: String) -> Result<(), String> {
    let mut config = load_config(&app);
    config.sync_path = Some(new_path);
    save_config(&app, &config)?;
    let _ = app.emit("sync_path_changed", ());
    Ok(())
}

pub fn get_data_path(app: &AppHandle) -> PathBuf {
    let config = load_config(app);
    if let Some(p) = config.sync_path {
        let pb = PathBuf::from(p);
        let _ = fs::create_dir_all(&pb);
        pb.join("todo_data.json")
    } else {
        let mut path = app.path().app_data_dir().unwrap_or_default();
        let _ = fs::create_dir_all(&path);
        path.push("todo_data.json");
        path
    }
}

/// 获取文件锁，exclusive=true 为排他锁，false 为共享锁
fn acquire_lock(path: &Path, exclusive: bool) -> Result<File, String> {
    let lock_path = path.with_extension("lock");
    for _ in 0..20 {
        if let Ok(file) = OpenOptions::new().read(true).write(true).create(true).open(&lock_path) {
            let ok = if exclusive {
                file.try_lock_exclusive().map_err(|_| ())
            } else {
                file.try_lock_shared().map_err(|_| ())
            };
            if ok.is_ok() { return Ok(file); }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("Failed to acquire {} lock after 1 second", if exclusive { "exclusive" } else { "shared" }))
}

/// 扫描备份目录，返回按修改时间降序排列的备份文件路径
fn scan_backups(backup_dir: &Path) -> Vec<PathBuf> {
    if !backup_dir.exists() {
        return vec![];
    }
    if let Ok(entries) = fs::read_dir(backup_dir) {
        let mut backups: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map_or(false, |ext| ext == "json") && p.file_name().unwrap().to_string_lossy().starts_with("todo_data_"))
            .collect();
        backups.sort_by(|a, b| {
            let m_a = fs::metadata(a).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let m_b = fs::metadata(b).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            m_b.cmp(&m_a)
        });
        backups
    } else {
        vec![]
    }
}

/// 原子写入：写入临时文件后 rename 到目标路径
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, data).map_err(|e| e.to_string())?;
    fs::rename(&temp_path, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_todo_data(app: AppHandle) -> Result<String, String> {
    let path = get_data_path(&app);
    if !path.exists() {
        return Ok("{}".to_string());
    }
    
    let _guard = acquire_lock(&path, false);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn create_backup(app: &AppHandle, path: &Path) {
    if !path.exists() {
        return;
    }
    let backup_dir = app.path().app_data_dir().unwrap_or_default().join("backups");
    let _ = fs::create_dir_all(&backup_dir);

    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let backup_file = backup_dir.join(format!("todo_data_{}.json", timestamp));
    let _ = fs::copy(path, &backup_file);

    // 清理旧备份，只保留最近 5 个
    let backups = scan_backups(&backup_dir);
    for b in backups.into_iter().skip(5) {
        let _ = fs::remove_file(b);
    }
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<String>, String> {
    let backup_dir = app.path().app_data_dir().unwrap_or_default().join("backups");
    let file_names = scan_backups(&backup_dir).into_iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    Ok(file_names)
}

#[tauri::command]
pub fn restore_backup(app: AppHandle, filename: String) -> Result<(), String> {
    let path = get_data_path(&app);
    let backup_dir = app.path().app_data_dir().unwrap_or_default().join("backups");
    let backup_file = backup_dir.join(&filename);

    if !backup_file.exists() {
        return Err("备份文件不存在".to_string());
    }

    let _guard = acquire_lock(&path, true)?;
    create_backup(&app, &path);

    let data = fs::read_to_string(&backup_file).map_err(|e| e.to_string())?;
    let res = atomic_write(&path, &data);

    let _ = app.emit("todo_data_changed", ());
    res
}

#[tauri::command]
pub fn write_todo_data(app: AppHandle, data: String) -> Result<(), String> {
    let path = get_data_path(&app);

    let _guard = acquire_lock(&path, true)?;
    create_backup(&app, &path);

    atomic_write(&path, &data)
}
