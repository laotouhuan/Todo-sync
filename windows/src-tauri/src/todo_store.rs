use std::fs::{self, OpenOptions, File};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;
use std::time::Duration;
use fs2::FileExt;

use crate::{WebdavHttpClient, GithubHttpClient};
use base64::Engine;
use std::time::SystemTime;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce
};
use sha2::{Digest, Sha256};
use rand::Rng;

// 常量定义
const MAX_BACKUP_COUNT: usize = 5;
const LOCK_RETRY_COUNT: usize = 20;
const LOCK_RETRY_INTERVAL_MS: u64 = 50;

/// 密码存储说明：
/// webdav_password 在磁盘上以 AES-256-GCM 加密存储（ENC: 前缀）。
/// 密钥由 app_data_dir + 本机用户名 + 硬编码盐值通过 SHA-256 派生，与本机绑定。
/// 旧版明文密码会在 load_config 时自动迁移为加密格式。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CollaborationSource {
    pub id: String,
    pub name: String,
    pub webdav_url: String,
    pub webdav_username: String,
    pub webdav_password: String,
    pub webdav_filepath: String,
    pub expire_at: Option<i64>, // Unix 时间戳，None 表示永久
    pub updated_at: String,     // 用于冲突合并的 ISO 8601 时间戳
    pub deleted: bool,          // 软删除标记
}

#[derive(Serialize)]
pub struct CollabReadResult {
    pub data: String,
    pub server_time: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    pub sync_mode: Option<String>, // "local" or "webdav"
    pub sync_path: Option<String>,
    pub webdav_url: Option<String>,
    pub webdav_username: Option<String>,
    pub webdav_password: Option<String>,
    pub webdav_filepath: Option<String>,
    pub nickname: Option<String>,
    pub default_due_date: Option<String>,
    pub default_insertion: Option<String>,
}

pub fn get_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(path.join("config.json"))
}

// ====== 本地密码加密工具 ======

/// 硬编码盐值，用于密钥派生（防止简单彩虹表攻击）
const LOCAL_CRYPTO_SALT: &[u8] = b"todo-sync-local-credential-protection-v1";

/// 基于本机特征派生 AES-256 密钥。
/// 输入材料：app_data_dir 路径 + 当前系统用户名 + 硬编码盐值。
/// 结果：密钥与本机绑定，config.json 复制到其他机器后无法解密。
fn derive_local_key(app: &AppHandle) -> [u8; 32] {
    let app_dir = app.path().app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let username = whoami::username();
    let mut hasher = Sha256::new();
    hasher.update(LOCAL_CRYPTO_SALT);
    hasher.update(app_dir.as_bytes());
    hasher.update(username.as_bytes());
    hasher.finalize().into()
}

/// 加密密码字符串，返回 "ENC:<base64(iv + ciphertext_with_tag)>" 格式。
/// 空字符串不加密，直接返回空字符串。
fn encrypt_password(app: &AppHandle, plaintext: &str) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    let key_bytes = derive_local_key(app);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).expect("Invalid key length");
    let mut rng = rand::thread_rng();
    let mut iv = [0u8; 12];
    rng.fill(&mut iv);
    let nonce = Nonce::from_slice(&iv);
    let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes())
        .expect("Encryption failed");
    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&iv);
    packed.extend_from_slice(&ciphertext);
    format!("ENC:{}", base64::engine::general_purpose::STANDARD.encode(&packed))
}

/// 解密密码字符串。若以 "ENC:" 开头则解密；否则视为明文旧数据直接返回。
/// 解密失败时返回空字符串（防止 panic）。
fn decrypt_password(app: &AppHandle, stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if let Some(b64) = stored.strip_prefix("ENC:") {
        let packed = match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(v) => v,
            Err(_) => { log::warn!("密码解密失败：Base64 解码错误"); return String::new(); }
        };
        if packed.len() < 12 + 16 {
            log::warn!("密码解密失败：数据长度不足");
            return String::new();
        }
        let (iv, ciphertext) = packed.split_at(12);
        let key_bytes = derive_local_key(app);
        let cipher = Aes256Gcm::new_from_slice(&key_bytes).expect("Invalid key length");
        let nonce = Nonce::from_slice(iv);
        match cipher.decrypt(nonce, ciphertext) {
            Ok(plaintext) => String::from_utf8(plaintext).unwrap_or_default(),
            Err(_) => {
                log::warn!("密码解密失败：密钥不匹配或数据损坏（可能是跨机器迁移导致）");
                String::new()
            }
        }
    } else {
        // 明文旧数据，直接返回
        stored.to_string()
    }
}

fn get_iso_timestamp() -> String {
    let now = SystemTime::now();
    let seconds = now.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = seconds / 86400;
    let seconds_in_day = seconds % 86400;
    let hours = seconds_in_day / 3600;
    let minutes = (seconds_in_day % 3600) / 60;
    let secs = seconds_in_day % 60;
    
    // 简易公历算法（适用于 1970-2099 年）
    let mut year = 1970;
    let mut day_count = days;
    loop {
        let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if is_leap { 366 } else { 365 };
        if day_count < days_in_year {
            break;
        }
        day_count -= days_in_year;
        year += 1;
    }
    
    let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let month_days = vec![31, if is_leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for m_days in month_days {
        if day_count < m_days {
            break;
        }
        day_count -= m_days;
        month += 1;
    }
    let day = day_count + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hours, minutes, secs)
}

pub fn get_collaborations_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config = load_config(app);
    if let Some(p) = config.sync_path {
        let pb = PathBuf::from(p);
        fs::create_dir_all(&pb).map_err(|e| format!("Failed to create sync dir: {e}"))?;
        Ok(pb.join("collaborations.json"))
    } else {
        let path = app.path().app_data_dir()
            .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create data dir: {e}"))?;
        Ok(path.join("collaborations.json"))
    }
}

pub fn read_collaborations_file(app: &AppHandle) -> Result<String, String> {
    let path = get_collaborations_path(app)?;
    if !path.exists() {
        return Ok("{\"version\":1,\"last_updated\":\"\",\"collaborations\":[]}".to_string());
    }
    let _guard = acquire_lock(&path, false)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub fn write_collaborations_file(app: &AppHandle, data: &str) -> Result<(), String> {
    let path = get_collaborations_path(app)?;
    let _guard = acquire_lock(&path, true)?;
    atomic_write(&path, data)
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let path = match get_config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    let data = match fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return AppConfig::default(),
    };

    // 尝试解析为 JSON Value 来处理老配置迁移
    if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&data) {
        if let Some(collabs_val) = val.get_mut("collaborations") {
            if let Some(collabs) = collabs_val.as_array() {
                if !collabs.is_empty() {
                    // 写入新的 collaborations.json
                    let mut new_collab_data = serde_json::json!({
                        "version": 1,
                        "last_updated": get_iso_timestamp(),
                        "collaborations": []
                    });
                    
                    if let Some(arr) = new_collab_data["collaborations"].as_array_mut() {
                        let now_iso = get_iso_timestamp();
                        for item in collabs {
                            let mut mapped_item = item.clone();
                            if mapped_item.get("updated_at").is_none() {
                                mapped_item["updated_at"] = serde_json::json!(now_iso);
                            }
                            if mapped_item.get("deleted").is_none() {
                                mapped_item["deleted"] = serde_json::json!(false);
                            }
                            arr.push(mapped_item);
                        }
                    }

                    if let Ok(collab_path) = get_collaborations_path(app) {
                        // 合并现有数据
                        if collab_path.exists() {
                            if let Ok(existing_str) = fs::read_to_string(&collab_path) {
                                if let Ok(mut existing_val) = serde_json::from_str::<serde_json::Value>(&existing_str) {
                                    if let Some(existing_arr) = existing_val["collaborations"].as_array_mut() {
                                        if let Some(new_arr) = new_collab_data["collaborations"].as_array() {
                                            for item in new_arr {
                                                if !existing_arr.iter().any(|existing_item| existing_item["id"].as_str() == item["id"].as_str()) {
                                                    existing_arr.push(item.clone());
                                                }
                                            }
                                        }
                                        new_collab_data = existing_val;
                                    }
                                }
                            }
                        }
                        if let Ok(data_str) = serde_json::to_string_pretty(&new_collab_data) {
                            let _ = write_collaborations_file(app, &data_str);
                        }
                    }
                }
            }
            // 移出 config 中的 collaborations 字段并重新保存
            if let Some(obj) = val.as_object_mut() {
                obj.remove("collaborations");
                if let Ok(cleaned_config) = serde_json::from_value::<AppConfig>(serde_json::Value::Object(obj.clone())) {
                    let _ = save_config(app, &cleaned_config);
                    return cleaned_config;
                }
            }
        }
    }

    let mut config: AppConfig = serde_json::from_str(&data).unwrap_or_default();

    // 自动迁移：解密磁盘上的加密密码，并将明文旧密码加密后回写
    if let Some(ref stored_pass) = config.webdav_password {
        if !stored_pass.is_empty() {
            if stored_pass.starts_with("ENC:") {
                // 已加密，解密为内存中的明文
                config.webdav_password = Some(decrypt_password(app, stored_pass));
            } else {
                // 明文旧数据，加密后回写磁盘（迁移）
                let encrypted = encrypt_password(app, stored_pass);
                let mut disk_config = config.clone();
                disk_config.webdav_password = Some(encrypted);
                let _ = save_config_raw(app, &disk_config);
                // config 中保持明文供调用方使用
            }
        }
    }

    config
}

/// 原始保存：直接将 AppConfig 序列化后写入磁盘，不做加密处理。
/// 仅在内部迁移逻辑中使用（调用方已自行处理加密）。
fn save_config_raw(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = get_config_path(app)?;
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

/// 保存配置：密码字段会在写入前自动加密。
/// 调用方传入的 config.webdav_password 应为明文。
pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let mut disk_config = config.clone();
    // 加密密码后写入磁盘
    if let Some(ref pass) = disk_config.webdav_password {
        if !pass.is_empty() && !pass.starts_with("ENC:") {
            disk_config.webdav_password = Some(encrypt_password(app, pass));
        }
    }
    save_config_raw(app, &disk_config)
}

#[tauri::command]
pub fn get_app_config(app: AppHandle) -> AppConfig {
    load_config(&app)
}

#[tauri::command]
pub fn save_app_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    // 验证 WebDAV URL 必须使用 HTTPS，防止凭据明文传输
    if let Some(ref url) = config.webdav_url {
        if !url.is_empty() && !url.starts_with("https://") {
            return Err("WebDAV URL 必须使用 https:// 协议，以保护凭据安全".to_string());
        }
    }
    save_config(&app, &config)
}

/// WebDAV 连接信息，包含认证凭据和构建好的目标 URL
struct WebDavConn {
    user: String,
    pass: String,
    target: String,
}

fn get_webdav_credentials(config: &AppConfig) -> Result<(String, String, String), String> {
    if config.sync_mode.as_deref() != Some("webdav") {
        return Err("Not in WebDAV mode".to_string());
    }
    let url = config.webdav_url.as_deref().unwrap_or("https://dav.jianguoyun.com/dav/").to_string();
    let user = config.webdav_username.as_deref().unwrap_or("").to_string();
    let pass = config.webdav_password.as_deref().unwrap_or("").to_string();
    Ok((url, user, pass))
}

/// 从配置中构建 WebDAV 连接信息
fn build_webdav_conn(config: &AppConfig) -> Result<WebDavConn, String> {
    let (url, user, pass) = get_webdav_credentials(config)?;
    let file_path = config.webdav_filepath.as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("我的坚果云/to-do/todo_data.json");

    let encoded_path = file_path.split('/').map(|s| {
        if s.is_empty() { String::new() } else { urlencoding::encode(s).into_owned() }
    }).collect::<Vec<_>>().join("/");

    let target = format!("{}/{}", url.trim_end_matches('/'), encoded_path);

    Ok(WebDavConn { user, pass, target })
}

#[tauri::command]
pub async fn sync_to_cloud(app: AppHandle, data: String) -> Result<(), String> {
    let config = load_config(&app);
    let conn = build_webdav_conn(&config)?;
    let client = app.state::<WebdavHttpClient>().inner().0.clone();

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

async fn check_parent_folder_exists(client: &reqwest::Client, parent_url: &str, user: &str, pass: &str) -> bool {
    let xml_body = "<?xml version=\"1.0\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:displayname/></D:prop></D:propfind>";
    let propfind_method = match reqwest::Method::from_bytes(b"PROPFIND") {
        Ok(m) => m,
        Err(_) => return false,
    };
    let resp = client.request(propfind_method, parent_url)
        .basic_auth(user, Some(pass))
        .header("Depth", "0")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(xml_body)
        .send().await;

    match resp {
        Ok(r) => r.status().is_success() || r.status().as_u16() == 207,
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn fetch_from_cloud(app: AppHandle) -> Result<String, String> {
    let config = load_config(&app);
    let conn = build_webdav_conn(&config)?;
    let client = app.state::<WebdavHttpClient>().inner().0.clone();

    let resp = client.get(&conn.target)
        .basic_auth(&conn.user, Some(&conn.pass))
        .send().await.map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        resp.text().await.map_err(|e| e.to_string())
    } else if resp.status().as_u16() == 404 {
        let last_slash = conn.target.rfind('/').unwrap_or(0);
        if last_slash > 0 {
            let parent_url = &conn.target[..last_slash];
            if check_parent_folder_exists(&client, parent_url, &conn.user, &conn.pass).await {
                Err("FILE_NOT_FOUND".to_string())
            } else {
                Err("云端同步目录不存在，请先在坚果云中手动创建该文件夹。".to_string())
            }
        } else {
            Err("FILE_NOT_FOUND".to_string())
        }
    } else {
        Err(format!("WebDAV GET Error: {}", resp.status()))
    }
}

fn build_collaborations_webdav_conn(config: &AppConfig) -> Result<WebDavConn, String> {
    let (url, user, pass) = get_webdav_credentials(config)?;
    let file_path = config.webdav_filepath.as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("我的坚果云/to-do/todo_data.json");

    // 1.4 路径解析契约: 提取父目录并拼接 collaborations.json
    let parent_path = if let Some(idx) = file_path.rfind('/') {
        &file_path[..idx]
    } else if let Some(idx) = file_path.rfind('\\') {
        &file_path[..idx]
    } else {
        ""
    };
    let collab_file_path = if parent_path.is_empty() {
        "collaborations.json".to_string()
    } else {
        format!("{}/collaborations.json", parent_path)
    };

    let encoded_path = collab_file_path.split('/').map(|s| {
        if s.is_empty() { String::new() } else { urlencoding::encode(s).into_owned() }
    }).collect::<Vec<_>>().join("/");

    let target = format!("{}/{}", url.trim_end_matches('/'), encoded_path);

    Ok(WebDavConn { user, pass, target })
}

#[tauri::command]
pub async fn sync_collaborations_to_cloud(app: AppHandle, data: String) -> Result<(), String> {
    let config = load_config(&app);
    let conn = build_collaborations_webdav_conn(&config)?;
    let client = app.state::<WebdavHttpClient>().inner().0.clone();

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
pub async fn fetch_collaborations_from_cloud(app: AppHandle) -> Result<String, String> {
    let config = load_config(&app);
    let conn = build_collaborations_webdav_conn(&config)?;
    let client = app.state::<WebdavHttpClient>().inner().0.clone();

    let resp = client.get(&conn.target)
        .basic_auth(&conn.user, Some(&conn.pass))
        .send().await.map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        resp.text().await.map_err(|e| e.to_string())
    } else if resp.status().as_u16() == 404 {
        let last_slash = conn.target.rfind('/').unwrap_or(0);
        if last_slash > 0 {
            let parent_url = &conn.target[..last_slash];
            if check_parent_folder_exists(&client, parent_url, &conn.user, &conn.pass).await {
                Err("FILE_NOT_FOUND".to_string())
            } else {
                Err("云端同步目录不存在，请先在坚果云中手动创建该文件夹。".to_string())
            }
        } else {
            Err("FILE_NOT_FOUND".to_string())
        }
    } else {
        Err(format!("WebDAV GET Error: {}", resp.status()))
    }
}

#[tauri::command]
pub async fn pick_sync_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择坚果云同步目录 (Nutstore Sync Folder)")
        .pick_folder(move |folder_path| {
            let result = folder_path.map(|p| p.to_string());
            let _ = tx.send(result);
        });
    rx.await.map_err(|e| format!("Dialog cancelled: {e}"))
}

#[tauri::command]
pub fn get_sync_path(app: AppHandle) -> Option<String> {
    load_config(&app).sync_path
}

#[tauri::command]
pub fn set_sync_path(app: AppHandle, new_path: String) -> Result<(), String> {
    // 路径安全验证：防止路径遍历和写入系统目录
    let path = Path::new(&new_path);
    if new_path.contains("..") {
        return Err("同步路径不允许包含 '..'".to_string());
    }
    if !path.is_absolute() {
        return Err("同步路径必须是绝对路径".to_string());
    }
    let mut config = load_config(&app);
    config.sync_path = Some(new_path);
    save_config(&app, &config)?;
    let _ = app.emit("sync_path_changed", ());
    Ok(())
}

pub fn get_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config = load_config(app);
    if let Some(p) = config.sync_path {
        let pb = PathBuf::from(p);
        fs::create_dir_all(&pb).map_err(|e| format!("Failed to create sync dir: {e}"))?;
        Ok(pb.join("todo_data.json"))
    } else {
        let path = app.path().app_data_dir()
            .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create data dir: {e}"))?;
        Ok(path.join("todo_data.json"))
    }
}

/// 获取文件锁，exclusive=true 为排他锁，false 为共享锁
fn acquire_lock(path: &Path, exclusive: bool) -> Result<File, String> {
    let lock_path = path.with_extension("lock");
    for i in 0..LOCK_RETRY_COUNT {
        if let Ok(file) = OpenOptions::new().read(true).write(true).create(true).open(&lock_path) {
            let ok = if exclusive {
                file.try_lock_exclusive().map_err(|_| ())
            } else {
                file.try_lock_shared().map_err(|_| ())
            };
            if ok.is_ok() { return Ok(file); }
        }
        if i == LOCK_RETRY_COUNT - 1 {
            log::error!(
                "Failed to acquire {} lock after {} retries for {:?}",
                if exclusive { "exclusive" } else { "shared" },
                LOCK_RETRY_COUNT,
                lock_path
            );
        }
        std::thread::sleep(Duration::from_millis(LOCK_RETRY_INTERVAL_MS));
    }
    Err(format!("Failed to acquire {} lock after {} retries", if exclusive { "exclusive" } else { "shared" }, LOCK_RETRY_COUNT))
}

/// 扫描备份目录，返回按修改时间降序排列的备份文件路径
fn scan_backups(backup_dir: &Path) -> Vec<PathBuf> {
    if !backup_dir.exists() {
        return vec![];
    }
    if let Ok(entries) = fs::read_dir(backup_dir) {
        let mut backups: Vec<(PathBuf, std::time::SystemTime)> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension().map_or(false, |ext| ext == "json")
                    && p.file_name().map_or(false, |name| name.to_string_lossy().starts_with("todo_data_"))
            })
            .filter_map(|p| {
                let time = fs::metadata(&p).and_then(|m| m.modified()).ok()?;
                Some((p, time))
            })
            .collect();
        backups.sort_by(|a, b| b.1.cmp(&a.1));
        backups.into_iter().map(|(p, _)| p).collect()
    } else {
        vec![]
    }
}

/// 原子写入：写入临时文件，确保 sync_all 刷入物理磁盘后 rename 到目标路径
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    use std::io::Write;
    let temp_path = path.with_extension("tmp");
    {
        let mut file = File::create(&temp_path).map_err(|e| e.to_string())?;
        file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&temp_path, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_todo_data(app: AppHandle) -> Result<String, String> {
    let path = get_data_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }

    let _guard = acquire_lock(&path, false)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn create_backup(app: &AppHandle, path: &Path) {
    if !path.exists() {
        return;
    }
    let backup_dir = match app.path().app_data_dir() {
        Ok(p) => p.join("backups"),
        Err(_) => return,
    };
    let _ = fs::create_dir_all(&backup_dir);

    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let backup_file = backup_dir.join(format!("todo_data_{}.json", timestamp));
    let _ = fs::copy(path, &backup_file);

    // 清理旧备份，只保留最近 N 个
    let backups = scan_backups(&backup_dir);
    for b in backups.into_iter().skip(MAX_BACKUP_COUNT) {
        let _ = fs::remove_file(b);
    }
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<String>, String> {
    let backup_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("backups");
    let file_names = scan_backups(&backup_dir).into_iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    Ok(file_names)
}

#[tauri::command]
pub fn restore_backup(app: AppHandle, filename: String) -> Result<(), String> {
    // 路径遍历防护：清理文件名，拒绝包含路径分隔符或 .. 的输入
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("非法的备份文件名".to_string());
    }
    let path = get_data_path(&app)?;
    let backup_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("backups");
    let backup_file = backup_dir.join(&filename);

    // 先检查文件存在性，再做 canonicalize
    if !backup_file.exists() {
        return Err("备份文件不存在".to_string());
    }

    // 二次验证：解析后的路径必须仍在备份目录内
    let canonical_backup_dir = backup_dir.canonicalize().unwrap_or(backup_dir.clone());
    let canonical_file = backup_file.canonicalize().unwrap_or(backup_file.clone());
    if !canonical_file.starts_with(&canonical_backup_dir) {
        return Err("备份文件路径越界".to_string());
    }

    let _guard = acquire_lock(&path, true)?;
    create_backup(&app, &path);

    let data = fs::read_to_string(&backup_file).map_err(|e| e.to_string())?;
    let res = atomic_write(&path, &data);

    if res.is_ok() {
        let _ = app.emit("todo_data_changed", ());
    }
    res
}

#[tauri::command]
pub fn write_todo_data(app: AppHandle, data: String) -> Result<(), String> {
    let path = get_data_path(&app)?;

    let _guard = acquire_lock(&path, true)?;
    create_backup(&app, &path);

    atomic_write(&path, &data)
}

#[tauri::command]
pub fn read_collaborations_data(app: AppHandle) -> Result<String, String> {
    read_collaborations_file(&app)
}

#[tauri::command]
pub fn write_collaborations_data(app: AppHandle, data: String) -> Result<(), String> {
    write_collaborations_file(&app, &data)
}

#[tauri::command]
pub async fn get_latest_release(app: AppHandle) -> Result<String, String> {
    let client = app.state::<GithubHttpClient>().inner().0.clone();

    let resp = client.get("https://api.github.com/repos/laotouhuan/Todo-sync/releases/latest")
        .header("User-Agent", "Todo-App-Tauri")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        resp.text().await.map_err(|e| e.to_string())
    } else {
        Err(format!("GitHub API Error: {}", resp.status()))
    }
}

fn find_collaboration_source(app: &AppHandle, collab_id: &str) -> Result<CollaborationSource, String> {
    let collab_path = get_collaborations_path(app)?;
    if !collab_path.exists() {
        return Err("未找到协作清单".into());
    }
    let content = read_collaborations_file(app)?;
    let collab_data: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    let list = collab_data["collaborations"].as_array()
        .ok_or("数据损坏")?;
    
    for v in list {
        let mut c: CollaborationSource = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
        if c.id == collab_id {
            if c.deleted {
                return Err("该协作清单已被删除".into());
            }
            // 解密磁盘上的加密密码
            c.webdav_password = decrypt_password(app, &c.webdav_password);
            return Ok(c);
        }
    }
    Err("未找到协作清单".into())
}

#[tauri::command]
pub fn get_collaborations(app: AppHandle) -> Result<Vec<CollaborationSource>, String> {
    let collab_path = get_collaborations_path(&app)?;
    if !collab_path.exists() {
        return Ok(vec![]);
    }
    let content = read_collaborations_file(&app)?;
    let collab_data: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    let list = collab_data["collaborations"].as_array()
        .ok_or("数据损坏")?;
    
    let mut result = Vec::new();
    for v in list {
        let c: CollaborationSource = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
        if !c.deleted {
            result.push(c);
        }
    }
    
    Ok(result)
}

#[tauri::command]
pub fn decrypt_share_code(
    code: String,
    key_str: String
) -> Result<serde_json::Value, String> {
    let b64 = code.strip_prefix("tdsync://").ok_or("授权码须以 tdsync:// 开头")?;
    let packed = base64::engine::general_purpose::STANDARD.decode(b64)
        .map_err(|_| "Base64 解码失败")?;

    if packed.len() < 12 + 16 {
        return Err("授权码数据损坏".into());
    }

    // 1. 解析出 IV 和 密文+Tag
    let (iv, ciphertext_with_tag) = packed.split_at(12);

    // 2. 从密钥字符串派生密钥
    let mut hasher = Sha256::new();
    hasher.update(key_str.trim().as_bytes());
    let key_bytes = hasher.finalize();

    // 3. AES-GCM-256 解密
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(iv);
    
    let decrypted_bytes = cipher.decrypt(nonce, ciphertext_with_tag)
        .map_err(|e| format!("口令错误或已被篡改 (解密失败: {})", e))?;

    let plaintext = String::from_utf8(decrypted_bytes)
        .map_err(|_| "解密后的数据无效 (编码错误)")?;

    let v: serde_json::Value = serde_json::from_str(&plaintext)
        .map_err(|_| "解密后的 JSON 无效")?;

    Ok(v)
}

#[tauri::command]
pub fn generate_share_code(app: AppHandle, expire_days: Option<u32>) -> Result<(String, String), String> {
    let config = load_config(&app);
    if config.sync_mode.as_deref() != Some("webdav") {
        return Err("请先配置 WebDAV 同步模式".into());
    }
    let user = config.webdav_username.as_deref().filter(|s| !s.is_empty())
        .ok_or("WebDAV 账号为空")?;
    let pass = config.webdav_password.as_deref().filter(|s| !s.is_empty())
        .ok_or("WebDAV 密码为空")?;
    let url = config.webdav_url.as_deref().unwrap_or("https://dav.jianguoyun.com/dav/");
    let path = config.webdav_filepath.as_deref()
        .filter(|s| !s.is_empty()).unwrap_or("我的坚果云/to-do/todo_data.json");
    let exp: i64 = match expire_days {
        Some(d) => SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64
            + (d as i64) * 86400,
        None => 0,
    };
    
    // 1. 生成 12 位随机提取密钥 (A-Z, a-z, 0-9)
    let charset: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    let key_str: String = (0..12)
        .map(|_| {
            let idx = rng.gen_range(0..charset.len());
            charset[idx] as char
        })
        .collect();

    // 2. 从密钥字符串派生 256 位密钥 (SHA-256)
    let mut hasher = Sha256::new();
    hasher.update(key_str.as_bytes());
    let key_bytes = hasher.finalize();

    // 3. 构建待加密的明文 JSON
    let json = serde_json::json!({ "url": url, "user": user, "pass": pass, "path": path, "exp": exp });
    let plaintext = serde_json::to_string(&json).unwrap();

    // 4. AES-GCM-256 加密
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())?;
    
    // 生成 12 字节随机 IV
    let mut iv = [0u8; 12];
    rng.fill(&mut iv);
    let nonce = Nonce::from_slice(&iv);

    let ciphertext_with_tag = cipher.encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("加密错误: {}", e))?;

    // 5. 拼接结构: IV (12 字节) + Ciphertext + Tag
    let mut packed = Vec::with_capacity(iv.len() + ciphertext_with_tag.len());
    packed.extend_from_slice(&iv);
    packed.extend_from_slice(&ciphertext_with_tag);

    // 6. Base64 编码并加上 tdsync:// 前缀
    let base64_str = base64::engine::general_purpose::STANDARD.encode(&packed);
    let share_code = format!("tdsync://{}", base64_str);

    Ok((share_code, key_str))
}

#[tauri::command]
pub fn import_share_code(
    app: AppHandle,
    code: String,
    key: String,
    name: String
) -> Result<CollaborationSource, String> {
    // 1. 解密
    let decrypted = decrypt_share_code(code, key)?;
    let url = decrypted["url"].as_str().ok_or("缺少 url")?.to_string();
    let user = decrypted["user"].as_str().ok_or("缺少 user")?.to_string();
    let pass = decrypted["pass"].as_str().ok_or("缺少 pass")?.to_string();
    let path = decrypted["path"].as_str().ok_or("缺少 path")?.to_string();
    let exp = decrypted["exp"].as_i64().unwrap_or(0);
    if !url.starts_with("https://") { return Err("URL 必须使用 https".into()); }

    // 2. 加锁读取现有的 collaborations.json
    let collab_path = get_collaborations_path(&app)?;
    let mut collab_data = if collab_path.exists() {
        let content = read_collaborations_file(&app)?;
        serde_json::from_str::<serde_json::Value>(&content).unwrap_or(serde_json::json!({
            "version": 1,
            "last_updated": "",
            "collaborations": []
        }))
    } else {
        serde_json::json!({
            "version": 1,
            "last_updated": "",
            "collaborations": []
        })
    };

    let collabs = collab_data["collaborations"].as_array_mut().ok_or("数据损坏")?;
    
    // 3. 查重并合并 (LWW)
    let now_iso = get_iso_timestamp();
    let mut result = None;
    if let Some(existing) = collabs.iter_mut().find(|c| {
        c["webdav_url"].as_str() == Some(&url)
            && c["webdav_username"].as_str() == Some(&user)
            && c["webdav_filepath"].as_str() == Some(&path)
    }) {
        existing["webdav_password"] = serde_json::json!(encrypt_password(&app, &pass));
        existing["expire_at"] = if exp == 0 { serde_json::Value::Null } else { serde_json::json!(exp) };
        existing["updated_at"] = serde_json::json!(now_iso);
        existing["deleted"] = serde_json::json!(false);
        existing["name"] = serde_json::json!(name);
        
        let src: CollaborationSource = serde_json::from_value(existing.clone()).map_err(|e| e.to_string())?;
        result = Some(src);
    } else {
        let src = CollaborationSource {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            webdav_url: url,
            webdav_username: user,
            webdav_password: encrypt_password(&app, &pass),
            webdav_filepath: path,
            expire_at: if exp == 0 { None } else { Some(exp) },
            updated_at: now_iso.clone(),
            deleted: false,
        };
        collabs.push(serde_json::to_value(&src).unwrap());
        result = Some(src);
    }

    collab_data["last_updated"] = serde_json::json!(now_iso);
    
    // 4. 写回 collaborations.json
    let data_str = serde_json::to_string_pretty(&collab_data).map_err(|e| e.to_string())?;
    write_collaborations_file(&app, &data_str)?;

    Ok(result.unwrap())
}

#[tauri::command]
pub fn delete_collaboration(app: AppHandle, id: String) -> Result<(), String> {
    let collab_path = get_collaborations_path(&app)?;
    if !collab_path.exists() {
        return Ok(());
    }

    let content = read_collaborations_file(&app)?;
    let mut collab_data = serde_json::from_str::<serde_json::Value>(&content).unwrap_or(serde_json::json!({
        "version": 1,
        "last_updated": "",
        "collaborations": []
    }));

    let collabs = collab_data["collaborations"].as_array_mut().ok_or("数据损坏")?;
    let now_iso = get_iso_timestamp();
    let mut found = false;
    for c in collabs.iter_mut() {
        if c["id"].as_str() == Some(&id) {
            c["deleted"] = serde_json::json!(true);
            c["updated_at"] = serde_json::json!(now_iso);
            found = true;
            break;
        }
    }

    if found {
        collab_data["last_updated"] = serde_json::json!(now_iso);
        let data_str = serde_json::to_string_pretty(&collab_data).map_err(|e| e.to_string())?;
        write_collaborations_file(&app, &data_str)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn read_collaboration_todos(app: AppHandle, collab_id: String) -> Result<CollabReadResult, String> {
    let collab = find_collaboration_source(&app, &collab_id)?;
    let target = build_collab_url(&collab);
    let client = app.state::<WebdavHttpClient>().inner().0.clone();
    let resp = client.get(&target)
        .basic_auth(&collab.webdav_username, Some(&collab.webdav_password))
        .send().await.map_err(|e| format!("网络错误：{e}"))?;
    let server_time = resp.headers().get("date")
        .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    
    // 过期校验（用服务器时间）
    if let Some(exp) = collab.expire_at {
        if !server_time.is_empty() {
            if let Ok(dt) = httpdate::parse_http_date(&server_time) {
                let secs = dt.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
                if secs > exp { return Err("EXPIRED".into()); }
            } else {
                return Err("无法验证服务器安全时间，授权已锁定".into());
            }
        } else {
            return Err("无法验证服务器安全时间，授权已锁定".into());
        }
    }
    
    match resp.status().as_u16() {
        200..=299 => Ok(CollabReadResult {
            data: resp.text().await.map_err(|e| e.to_string())?,
            server_time
        }),
        401 => Err("凭据无效或已被撤销".into()),
        404 => Err("对方待办数据文件不存在".into()),
        s => Err(format!("WebDAV 错误：{s}")),
    }
}

#[tauri::command]
pub async fn write_collaboration_todo(
    app: AppHandle, collab_id: String, todo_json: String
) -> Result<(), String> {
    let collab = find_collaboration_source(&app, &collab_id)?;
    let target = build_collab_url(&collab);
    let client = app.state::<WebdavHttpClient>().inner().0.clone();
    
    // 1. 拉取
    let resp = client.get(&target)
        .basic_auth(&collab.webdav_username, Some(&collab.webdav_password))
        .send().await.map_err(|e| format!("拉取失败：{e}"))?;
        
    // 过期校验
    if let Some(exp) = collab.expire_at {
        if let Some(dh) = resp.headers().get("date").and_then(|v| v.to_str().ok()) {
            if let Ok(dt) = httpdate::parse_http_date(dh) {
                let s = dt.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
                if s > exp { return Err("EXPIRED".into()); }
            } else {
                return Err("无法验证服务器安全时间，授权已锁定".into());
            }
        } else {
            return Err("无法验证服务器安全时间，授权已锁定".into());
        }
    }
    
    if !resp.status().is_success() { return Err(format!("拉取失败：{}", resp.status())); }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    
    // 2. 追加
    let mut doc: serde_json::Value = serde_json::from_str(&body)
        .unwrap_or(serde_json::json!({"version":1,"last_updated":"","todos":[]}));
    let new_todo: serde_json::Value = serde_json::from_str(&todo_json)
        .map_err(|e| format!("todo JSON 无效：{e}"))?;
        
    let todos = doc["todos"].as_array_mut().ok_or("todos 字段异常")?;
    let new_id = new_todo["id"].as_str().unwrap_or("");
    if !new_id.is_empty() && todos.iter().any(|t| t["id"].as_str() == Some(new_id)) {
        // ID 重复则忽略不处理
    } else {
        todos.push(new_todo);
    }
    
    doc["last_updated"] = serde_json::Value::String(
        SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)
            .unwrap().as_secs().to_string()
    );
    
    // 3. 上传
    let updated = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let put = client.put(&target)
        .basic_auth(&collab.webdav_username, Some(&collab.webdav_password))
        .header("Content-Type", "application/json; charset=utf-8")
        .body(updated).send().await.map_err(|e| format!("上传失败：{e}"))?;
        
    if put.status().is_success() { Ok(()) } else { Err(format!("上传失败：{}", put.status())) }
}

fn build_collab_url(collab: &CollaborationSource) -> String {
    let encoded = collab.webdav_filepath.split('/').map(|s| {
        if s.is_empty() { String::new() } else { urlencoding::encode(s).into_owned() }
    }).collect::<Vec<_>>().join("/");
    let url = &collab.webdav_url;
    if url.ends_with('/') { format!("{url}{encoded}") } else { format!("{url}/{encoded}") }
}
