use std::fs::{self, OpenOptions, File};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;
use std::time::Duration;
use fs2::FileExt;

use crate::{WebdavHttpClient, GithubHttpClient};
use crate::CollaborationHttpClient;
use base64::Engine;
use std::time::SystemTime;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce
};
use sha2::{Digest, Sha256};
use rand::Rng;

#[path = "collaboration_credentials.rs"]
mod collaboration_credentials;
#[path = "collaboration_access.rs"]
mod collaboration_access;

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
    #[serde(default)]
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
    pub complete_subtasks_with_parent: Option<bool>, // 缺失时默认不联动
    pub complete_parent_with_subtasks: Option<bool>, // 缺失时默认不联动
    pub time_tracking_enabled: Option<bool>, // 缺失时前端默认开启，本机偏好不参与数据同步
}

#[cfg(test)]
mod preference_tests {
    use super::AppConfig;

    #[test]
    fn subtask_preferences_default_off_and_round_trip_independently() {
        let old: AppConfig = serde_json::from_str("{}").unwrap();
        assert!(!old.complete_subtasks_with_parent.unwrap_or(false));
        assert!(!old.complete_parent_with_subtasks.unwrap_or(false));
        for children in [false, true] {
            for parent in [false, true] {
                let config = AppConfig {
                    complete_subtasks_with_parent: Some(children),
                    complete_parent_with_subtasks: Some(parent),
                    ..AppConfig::default()
                };
                let restored: AppConfig = serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
                assert_eq!(restored.complete_subtasks_with_parent, Some(children));
                assert_eq!(restored.complete_parent_with_subtasks, Some(parent));
            }
        }
    }

    #[test]
    fn old_config_keeps_timing_enabled() {
        let config: AppConfig = serde_json::from_str("{}").unwrap();
        assert!(config.time_tracking_enabled.unwrap_or(true));
        assert!(AppConfig::default().time_tracking_enabled.unwrap_or(true));
    }

    #[test]
    fn disabled_timing_survives_round_trip() {
        let config: AppConfig = serde_json::from_str(r#"{"time_tracking_enabled":false}"#).unwrap();
        let saved = serde_json::to_string(&config).unwrap();
        let restored: AppConfig = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored.time_tracking_enabled, Some(false));
    }
}

#[cfg(test)]
mod legacy_collaboration_migration_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // 仅用于临时文件测试，不使用本机真实配置或凭据。
    const TEST_KEY: [u8; 32] = [7; 32];

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("todo-collab-migration-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn legacy_config() -> serde_json::Value {
        serde_json::json!({
            "sync_path": "",
            "webdav_password": "legacy-password",
            "collaborations": [
                {"id": "same", "name": "legacy copy", "deleted": false},
                {"id": "new", "name": "new source", "extension": {"kept": true}}
            ]
        })
    }

    fn run_migration(
        config_path: &Path,
        collaborations_path: &Path,
        fail_target_write: bool,
        fail_config_write: bool,
    ) -> Result<AppConfig, String> {
        let raw_config: serde_json::Value = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        migrate_legacy_config_value(
            config_path,
            raw_config,
            Some(collaborations_path),
            |path, legacy_items| {
                merge_legacy_collaborations_at_path(path, legacy_items, |path, contents| {
                    if fail_target_write {
                        return Err("injected collaborations write failure".to_string());
                    }
                    atomic_write(path, contents)
                })
            },
            |path, config| {
                if fail_config_write {
                    return Err("injected config write failure".to_string());
                }
                save_migrated_config_atomic(&TEST_KEY, path, config)
            },
        )
    }

    #[test]
    fn resolves_sync_and_default_collaboration_paths() {
        let temp = TestDirectory::new();
        let app_data = temp.0.join("app-data");
        let sync_dir = temp.0.join("sync");

        let sync_path = collaborations_path_from_sync_path(sync_dir.to_str(), None).unwrap();
        let default_path = collaborations_path_from_sync_path(None, Some(&app_data)).unwrap();

        assert_eq!(sync_path, sync_dir.join("collaborations.json"));
        assert_eq!(default_path, app_data.join("collaborations.json"));
        assert!(sync_dir.is_dir());
        assert!(app_data.is_dir());
    }

    #[test]
    fn empty_legacy_list_is_removed_without_creating_collaboration_data() {
        let temp = TestDirectory::new();
        let config_path = temp.0.join("config.json");
        let collaborations_path = temp.0.join("collaborations.json");
        let raw_config = serde_json::json!({"collaborations": [], "sync_path": null});

        migrate_legacy_config_value(
            &config_path,
            raw_config,
            None,
            |_, _| panic!("empty legacy list must not write collaboration data"),
            |path, config| {
                save_migrated_config_atomic(&TEST_KEY, path, config)
            },
        ).unwrap();

        assert!(!collaborations_path.exists());
        let cleaned: serde_json::Value = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        assert!(cleaned.get("collaborations").is_none());
    }

    #[test]
    fn migration_preserves_existing_records_and_is_safe_to_retry() {
        let temp = TestDirectory::new();
        let config_path = temp.0.join("config.json");
        let collaborations_path = temp.0.join("collaborations.json");
        fs::write(&config_path, serde_json::to_vec_pretty(&legacy_config()).unwrap()).unwrap();
        fs::write(&collaborations_path, serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "last_updated": "existing timestamp",
            "extension_root": "preserve",
            "collaborations": [
                {"id": "same", "name": "existing copy", "deleted": true, "extension": "keep"}
            ]
        })).unwrap()).unwrap();

        let migrated = run_migration(&config_path, &collaborations_path, false, true);
        assert!(migrated.is_err());
        assert!(serde_json::from_slice::<serde_json::Value>(&fs::read(&config_path).unwrap()).unwrap()["collaborations"].is_array());

        run_migration(&config_path, &collaborations_path, false, false).unwrap();
        let target: serde_json::Value = serde_json::from_slice(&fs::read(&collaborations_path).unwrap()).unwrap();
        let records = target["collaborations"].as_array().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["name"], "existing copy");
        assert_eq!(records[0]["deleted"], true);
        assert_eq!(records[0]["extension"], "keep");
        assert_eq!(records[1]["updated_at"].as_str().unwrap().len() > 0, true);
        assert_eq!(records[1]["deleted"], false);
        assert_eq!(records[1]["extension"]["kept"], true);
        assert_eq!(target["extension_root"], "preserve");

        let cleaned: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert!(cleaned.get("collaborations").is_none());
        let stored = cleaned["webdav_password"].as_str().unwrap();
        assert!(stored.starts_with("ENC:"));
        assert_eq!(decrypt_password_with_key(&TEST_KEY, stored), "legacy-password");
    }

    #[test]
    fn target_write_failure_keeps_legacy_configuration_unchanged() {
        let temp = TestDirectory::new();
        let config_path = temp.0.join("config.json");
        let collaborations_path = temp.0.join("collaborations.json");
        let original_config = serde_json::to_vec_pretty(&legacy_config()).unwrap();
        let original_target = br#"{"version":1,"last_updated":"keep","collaborations":[]}"#.to_vec();
        fs::write(&config_path, &original_config).unwrap();
        fs::write(&collaborations_path, &original_target).unwrap();

        assert!(run_migration(&config_path, &collaborations_path, true, false).is_err());
        assert_eq!(fs::read(&config_path).unwrap(), original_config);
        assert_eq!(fs::read(&collaborations_path).unwrap(), original_target);
    }

    #[test]
    fn invalid_target_is_not_overwritten_or_removed_from_legacy_config() {
        let temp = TestDirectory::new();
        let config_path = temp.0.join("config.json");
        let collaborations_path = temp.0.join("collaborations.json");
        let original_config = serde_json::to_vec_pretty(&legacy_config()).unwrap();
        let invalid_target = b"{invalid json".to_vec();
        fs::write(&config_path, &original_config).unwrap();
        fs::write(&collaborations_path, &invalid_target).unwrap();

        assert!(run_migration(&config_path, &collaborations_path, false, false).is_err());
        assert_eq!(fs::read(&config_path).unwrap(), original_config);
        assert_eq!(fs::read(&collaborations_path).unwrap(), invalid_target);
    }

    #[test]
    fn full_load_migrates_sources_and_passwords_without_reimporting() {
        for encrypted in [false, true] {
            let temp = TestDirectory::new();
            let config_path = temp.0.join("config.json");
            let mut raw = legacy_config();
            raw["sync_path"] = serde_json::Value::Null;
            if encrypted {
                raw["webdav_password"] = serde_json::json!(encrypt_password_with_key(&TEST_KEY, "legacy-password"));
            }
            fs::write(&config_path, serde_json::to_vec(&raw).unwrap()).unwrap();

            let config = load_config_at_path(&config_path, &TEST_KEY);
            assert_eq!(config.webdav_password.as_deref(), Some("legacy-password"));
            let saved = fs::read(&config_path).unwrap();
            let disk: serde_json::Value = serde_json::from_slice(&saved).unwrap();
            assert!(disk.get("collaborations").is_none());
            assert!(disk["webdav_password"].as_str().unwrap().starts_with("ENC:"));
            if encrypted {
                assert_eq!(disk["webdav_password"], raw["webdav_password"]);
            }
            let target_path = temp.0.join("collaborations.json");
            let target = fs::read(&target_path).unwrap();
            let records: serde_json::Value = serde_json::from_slice(&target).unwrap();
            assert_eq!(records["collaborations"].as_array().unwrap().len(), 2);

            let reloaded = load_config_at_path(&config_path, &TEST_KEY);
            assert_eq!(reloaded.webdav_password.as_deref(), Some("legacy-password"));
            assert_eq!(fs::read(&config_path).unwrap(), saved);
            assert_eq!(fs::read(&target_path).unwrap(), target);
        }
    }

    #[test]
    fn failed_migration_survives_settings_save_and_sync_path_recovery() {
        for encrypted in [false, true] {
            let temp = TestDirectory::new();
            let config_path = temp.0.join("config.json");
            let bad_path = temp.0.join("collaborations.json");
            let mut raw = legacy_config();
            raw["sync_path"] = serde_json::Value::Null;
            if encrypted {
                raw["webdav_password"] = serde_json::json!(encrypt_password_with_key(&TEST_KEY, "legacy-password"));
            }
            let original = serde_json::to_vec(&raw).unwrap();
            fs::write(&config_path, &original).unwrap();
            fs::write(&bad_path, "invalid json").unwrap();

            let mut config = load_config_at_path(&config_path, &TEST_KEY);
            assert_eq!(config.webdav_password.as_deref(), Some("legacy-password"));
            // 加载失败不会为了加密明文密码而覆盖旧源。
            assert_eq!(fs::read(&config_path).unwrap(), original);
            config.nickname = Some("修改设置".to_string());
            save_config_at_path(&config_path, &TEST_KEY, &config).unwrap();
            let saved: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            assert_eq!(saved["collaborations"], raw["collaborations"]);
            assert_eq!(saved["nickname"], "修改设置");
            assert!(saved["webdav_password"].as_str().unwrap().starts_with("ENC:"));

            // 与 set_sync_path 相同：再次加载失败后改目录，再经普通保存入口提交。
            let mut recovered = load_config_at_path(&config_path, &TEST_KEY);
            let new_dir = temp.0.join("new-sync");
            recovered.sync_path = Some(new_dir.to_string_lossy().into_owned());
            save_config_at_path(&config_path, &TEST_KEY, &recovered).unwrap();
            let pending: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            assert_eq!(pending["collaborations"], raw["collaborations"]);

            let migrated = load_config_at_path(&config_path, &TEST_KEY);
            assert_eq!(migrated.webdav_password.as_deref(), Some("legacy-password"));
            let cleaned: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            assert!(cleaned.get("collaborations").is_none());
            let target: serde_json::Value = serde_json::from_slice(&fs::read(new_dir.join("collaborations.json")).unwrap()).unwrap();
            assert_eq!(target["collaborations"].as_array().unwrap().len(), 2);
            assert_eq!(fs::read_to_string(&bad_path).unwrap(), "invalid json");
        }
    }

    #[test]
    fn full_load_retries_real_target_and_config_write_failures() {
        for block_config in [false, true] {
            let temp = TestDirectory::new();
            let config_path = temp.0.join("config.json");
            let target_path = temp.0.join("collaborations.json");
            let mut raw = legacy_config();
            raw["sync_path"] = serde_json::Value::Null;
            let original = serde_json::to_vec(&raw).unwrap();
            fs::write(&config_path, &original).unwrap();
            let blocked_temp = if block_config { config_path.with_extension("tmp") } else { target_path.with_extension("tmp") };
            fs::create_dir(&blocked_temp).unwrap();

            let config = load_config_at_path(&config_path, &TEST_KEY);
            assert_eq!(config.webdav_password.as_deref(), Some("legacy-password"));
            assert_eq!(fs::read(&config_path).unwrap(), original);
            if block_config {
                assert!(save_config_at_path(&config_path, &TEST_KEY, &config).is_err());
                assert_eq!(fs::read(&config_path).unwrap(), original);
            }
            fs::remove_dir(&blocked_temp).unwrap();
            let loaded = load_config_at_path(&config_path, &TEST_KEY);
            assert_eq!(loaded.webdav_password.as_deref(), Some("legacy-password"));
            let cleaned: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            assert!(cleaned.get("collaborations").is_none());
            let target: serde_json::Value = serde_json::from_slice(&fs::read(&target_path).unwrap()).unwrap();
            assert_eq!(target["collaborations"].as_array().unwrap().len(), 2);
        }
    }

    #[test]
    fn plain_password_without_legacy_sources_is_encrypted_on_load() {
        let temp = TestDirectory::new();
        let path = temp.0.join("config.json");
        fs::write(&path, r#"{"webdav_password":"legacy-password"}"#).unwrap();
        let loaded = load_config_at_path(&path, &TEST_KEY);
        assert_eq!(loaded.webdav_password.as_deref(), Some("legacy-password"));
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(saved["webdav_password"].as_str().unwrap().starts_with("ENC:"));
        assert!(saved.get("collaborations").is_none());
        assert_eq!(load_config_at_path(&path, &TEST_KEY).webdav_password, loaded.webdav_password);
    }
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
    encrypt_password_with_key(&derive_local_key(app), plaintext)
}

fn encrypt_password_with_key(key: &[u8; 32], plaintext: &str) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    let cipher = Aes256Gcm::new_from_slice(key).expect("Invalid key length");
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
    decrypt_password_with_key(&derive_local_key(app), stored)
}

fn decrypt_password_with_key(key: &[u8; 32], stored: &str) -> String {
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
        let cipher = Aes256Gcm::new_from_slice(key).expect("Invalid key length");
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
    if let Some(sync_path) = config.sync_path.as_deref() {
        collaborations_path_from_sync_path(Some(sync_path), None)
    } else {
        let app_data_dir = app.path().app_data_dir()
            .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
        collaborations_path_from_sync_path(None, Some(&app_data_dir))
    }
}

fn collaborations_path_from_sync_path(
    sync_path: Option<&str>,
    app_data_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(p) = sync_path {
        let pb = PathBuf::from(p);
        fs::create_dir_all(&pb).map_err(|e| format!("Failed to create sync dir: {e}"))?;
        Ok(pb.join("collaborations.json"))
    } else {
        let app_data_dir = app_data_dir
            .ok_or_else(|| "Failed to resolve app data directory".to_string())?;
        fs::create_dir_all(app_data_dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
        Ok(app_data_dir.join("collaborations.json"))
    }
}

pub fn read_collaborations_file(app: &AppHandle) -> Result<String, String> {
    let path = get_collaborations_path(app)?;
    if !path.exists() {
        return Ok("{\"version\":1,\"last_updated\":\"\",\"collaborations\":[]}".to_string());
    }
    let _guard = acquire_lock(&path, true)?;
    read_collaborations_unlocked(app, &path)
}

fn read_collaborations_unlocked(app: &AppHandle, path: &Path) -> Result<String, String> {
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let private_path = collaboration_credentials_path(app)?;
    let shared = collaboration_credentials::save_and_redact(&data, &private_path, &derive_local_key(app))?;
    if shared != data {
        atomic_write(&path, &shared)?;
    }
    collaboration_credentials::restore(&shared, &private_path)
}

pub fn write_collaborations_file(app: &AppHandle, data: &str) -> Result<(), String> {
    let path = get_collaborations_path(app)?;
    let _guard = acquire_lock(&path, true)?;
    write_collaborations_unlocked(app, &path, data)
}

fn write_collaborations_unlocked(app: &AppHandle, path: &Path, data: &str) -> Result<(), String> {
    let private_path = collaboration_credentials_path(app)?;
    let shared = collaboration_credentials::save_and_redact(data, &private_path, &derive_local_key(app))?;
    atomic_write(&path, &shared)
}

fn collaboration_credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join("collaboration-credentials.json"))
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let path = match get_config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    load_config_at_path(&path, &derive_local_key(app))
}

// 测试与正式加载共用完整流程，仅由调用方提供路径和本机密钥。
fn load_config_at_path(path: &Path, key: &[u8; 32]) -> AppConfig {
    let data = match fs::read_to_string(path) {
        Ok(d) => d,
        Err(_) => return AppConfig::default(),
    };

    // 尝试解析为 JSON Value 来处理老配置迁移。
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) {
        if value.get("collaborations").is_some() {
            let sync_path = value.get("sync_path").and_then(serde_json::Value::as_str);
            let app_data_dir = path.parent();
            let collab_path = match app_data_dir {
                Some(dir) if value["collaborations"].as_array().map_or(false, |items| !items.is_empty()) => {
                    collaborations_path_from_sync_path(sync_path, Some(dir)).map(Some)
                }
                _ => Ok(None),
            };

            let migration = collab_path.and_then(|collab_path| {
                migrate_legacy_config_value(
                    path,
                    value,
                    collab_path.as_deref(),
                    |target_path, legacy_items| {
                        merge_legacy_collaborations_at_path(target_path, legacy_items, |target, contents| {
                            let private_path = path.parent().ok_or("无法定位本机凭据目录")?
                                .join("collaboration-credentials.json");
                            let shared = collaboration_credentials::save_and_redact(contents, &private_path, key)?;
                            atomic_write(target, &shared)
                        })
                    },
                    |config_path, config| save_migrated_config_atomic(key, config_path, config),
                )
            });

            return match migration {
                Ok(mut config) => {
                    decrypt_config_password(key, &mut config);
                    config
                }
                Err(error) => {
                    log::error!("旧协作配置迁移失败，保留原配置以便重试：{error}");
                    let mut config = serde_json::from_str::<AppConfig>(&data).unwrap_or_default();
                    decrypt_config_password(key, &mut config);
                    config
                }
            };
        }
    }

    let mut config: AppConfig = serde_json::from_str(&data).unwrap_or_default();

    // 自动迁移：解密磁盘上的加密密码，并将明文旧密码加密后回写
    if let Some(ref stored_pass) = config.webdav_password {
        if !stored_pass.is_empty() {
            if stored_pass.starts_with("ENC:") {
                // 已加密，解密为内存中的明文
                config.webdav_password = Some(decrypt_password_with_key(key, stored_pass));
            } else {
                // 明文旧数据，加密后回写磁盘（迁移）
                let encrypted = encrypt_password_with_key(key, stored_pass);
                let mut disk_config = config.clone();
                disk_config.webdav_password = Some(encrypted);
                let _ = save_config_value_at_path(path, &disk_config);
                // config 中保持明文供调用方使用
            }
        }
    }

    config
}

fn decrypt_config_password(key: &[u8; 32], config: &mut AppConfig) {
    if let Some(stored_pass) = config.webdav_password.as_deref() {
        if stored_pass.starts_with("ENC:") {
            config.webdav_password = Some(decrypt_password_with_key(key, stored_pass));
        }
    }
}

fn merge_legacy_collaborations_at_path(
    path: &Path,
    legacy_items: &[serde_json::Value],
    write_file: impl FnOnce(&Path, &str) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = acquire_lock(path, true)?;
    let mut target = if path.exists() {
        let existing = fs::read_to_string(path).map_err(|e| format!("Failed to read collaborations file: {e}"))?;
        let parsed: serde_json::Value = serde_json::from_str(&existing)
            .map_err(|e| format!("Failed to parse collaborations file: {e}"))?;
        if !parsed["collaborations"].is_array() {
            return Err("Invalid collaborations file: collaborations must be an array".to_string());
        }
        parsed
    } else {
        serde_json::json!({
            "version": 1,
            "last_updated": get_iso_timestamp(),
            "collaborations": []
        })
    };

    let existing_items = target["collaborations"].as_array_mut()
        .ok_or_else(|| "Invalid collaborations file: collaborations must be an array".to_string())?;
    let now = get_iso_timestamp();
    for item in legacy_items {
        let mut mapped_item = item.clone();
        if mapped_item.get("updated_at").is_none() {
            mapped_item["updated_at"] = serde_json::json!(now);
        }
        if mapped_item.get("deleted").is_none() {
            mapped_item["deleted"] = serde_json::json!(false);
        }
        if !existing_items.iter().any(|existing| existing["id"].as_str() == mapped_item["id"].as_str()) {
            existing_items.push(mapped_item);
        }
    }

    let serialized = serde_json::to_string_pretty(&target).map_err(|e| e.to_string())?;
    write_file(path, &serialized)
}

fn migrate_legacy_config_value(
    config_path: &Path,
    mut raw_config: serde_json::Value,
    collaborations_path: Option<&Path>,
    write_collaborations: impl FnOnce(&Path, &[serde_json::Value]) -> Result<(), String>,
    persist_config: impl FnOnce(&Path, &AppConfig) -> Result<(), String>,
) -> Result<AppConfig, String> {
    let legacy_items = raw_config.get("collaborations")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !legacy_items.is_empty() {
        let path = collaborations_path.ok_or_else(|| "Failed to resolve collaborations file path".to_string())?;
        write_collaborations(path, &legacy_items)?;
    }

    let object = raw_config.as_object_mut()
        .ok_or_else(|| "Invalid config: expected a JSON object".to_string())?;
    object.remove("collaborations");
    let config = serde_json::from_value::<AppConfig>(serde_json::Value::Object(object.clone()))
        .map_err(|e| format!("Failed to parse migrated config: {e}"))?;
    persist_config(config_path, &config)?;
    Ok(config)
}

fn save_migrated_config_atomic(key: &[u8; 32], path: &Path, config: &AppConfig) -> Result<(), String> {
    let disk_config = config_for_storage(key, config);
    let serialized = serde_json::to_string_pretty(&disk_config).map_err(|e| e.to_string())?;
    let _guard = acquire_lock(path, true)?;
    atomic_write(path, &serialized)
}

// 普通保存和密码回写均保留迁移源；只有成功迁移的提交入口可以移除它。
fn save_config_value_at_path(path: &Path, disk_config: &AppConfig) -> Result<(), String> {
    let _guard = acquire_lock(path, true)?;
    let mut value = serde_json::to_value(disk_config).map_err(|e| e.to_string())?;
    match fs::read_to_string(path) {
        Ok(contents) => {
            let previous: serde_json::Value = serde_json::from_str(&contents)
                .map_err(|_| "配置文件无法解析，已保留原文件，未保存设置".to_string())?;
            if let Some(legacy) = previous.get("collaborations") {
                value["collaborations"] = legacy.clone();
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Failed to read config: {error}")),
    }
    let data = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    atomic_write(path, &data)
}

/// 保存配置：密码字段会在写入前自动加密。
/// 调用方传入的 config.webdav_password 应为明文。
pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    save_config_at_path(&get_config_path(app)?, &derive_local_key(app), config)
}

fn save_config_at_path(path: &Path, key: &[u8; 32], config: &AppConfig) -> Result<(), String> {
    save_config_value_at_path(path, &config_for_storage(key, config))
}

fn config_for_storage(key: &[u8; 32], config: &AppConfig) -> AppConfig {
    let mut disk_config = config.clone();
    // 加密密码后写入磁盘
    if let Some(ref pass) = disk_config.webdav_password {
        if !pass.is_empty() && !pass.starts_with("ENC:") {
            disk_config.webdav_password = Some(encrypt_password_with_key(key, pass));
        }
    }
    disk_config
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
    // 在最终网络出口统一剥离密码，包括旧客户端格式和已删除记录。
    let data = collaboration_credentials::shared(&data)?;
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
        let data = resp.text().await.map_err(|e| e.to_string())?;
        collaboration_credentials::shared(&data)
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

/// 通过用户选定的文件路径导出，完成写入后才向前端报告成功。
#[tauri::command]
pub async fn export_review_markdown(app: tauri::AppHandle, filename: String, content: String) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("导出复盘 Markdown").set_file_name(&filename)
        .add_filter("Markdown", &["md"]).save_file(move |path| { let _ = tx.send(path); });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(false); };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
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
            if c.webdav_password.is_empty() {
                return Err("请在此设备重新导入该清单的分享码，以启用访问".into());
            }
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

fn share_payload(config: &AppConfig, exp: i64) -> Result<collaboration_access::SharePayload, String> {
    if config.sync_mode.as_deref() != Some("webdav") {
        return Err("请先配置 WebDAV 同步模式".into());
    }
    Ok(collaboration_access::SharePayload {
        url: config.webdav_url.clone().unwrap_or_else(|| "https://dav.jianguoyun.com/dav/".into()),
        user: config.webdav_username.clone().unwrap_or_default(),
        pass: config.webdav_password.clone().unwrap_or_default(),
        path: config.webdav_filepath.clone().unwrap_or_else(|| "我的坚果云/to-do/todo_data.json".into()),
        exp,
    })
}

#[tauri::command]
pub async fn generate_share_code(app: AppHandle, expire_days: Option<u32>) -> Result<(String, String), String> {
    let exp = expire_days.map(|d| SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default().as_secs() as i64 + i64::from(d) * 86400).unwrap_or(0);
    let snapshot = share_payload(&load_config(&app), exp)?;
    let expected = snapshot.clone();
    let client = app.state::<CollaborationHttpClient>().inner().0.clone();
    collaboration_access::generate(&client, snapshot, ||
        share_payload(&load_config(&app), exp).map(|current| current == expected).unwrap_or(false)
    ).await
}

#[tauri::command]
pub async fn import_share_code(
    app: AppHandle,
    code: String,
    key: String,
    name: String
) -> Result<CollaborationSource, String> {
    if name.trim().is_empty() { return Err("请为协作清单命名".into()); }
    let payload = collaboration_access::decode(code, key)?;
    let client = app.state::<CollaborationHttpClient>().inner().0.clone();
    collaboration_access::import(&client, payload, |payload| {
        let collaboration_access::SharePayload { url, user, pass, path, exp } = payload;
        // 验证后重新读取最新文件；同一把锁覆盖整个提交。
        let collab_path = get_collaborations_path(&app)?;
        let _guard = acquire_lock(&collab_path, true)?;
        let mut collab_data = if collab_path.exists() {
            let content = read_collaborations_unlocked(&app, &collab_path)?;
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
        let result = if let Some(existing) = collabs.iter_mut().find(|c| {
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
            src
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
            src
        };

        collab_data["last_updated"] = serde_json::json!(now_iso);

        // 4. 写回 collaborations.json
        let data_str = serde_json::to_string_pretty(&collab_data).map_err(|e| e.to_string())?;
        write_collaborations_unlocked(&app, &collab_path, &data_str)?;

        Ok(result)
    }).await
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
    let client = app.state::<CollaborationHttpClient>().inner().0.clone();
    collaboration_access::read(&client, &collab).await
}

#[tauri::command]
pub async fn write_collaboration_todo(
    app: AppHandle, collab_id: String, todo_json: String
) -> Result<(), String> {
    let collab = find_collaboration_source(&app, &collab_id)?;
    let target = build_collab_url(&collab);
    let client = app.state::<CollaborationHttpClient>().inner().0.clone();
    let body = collaboration_access::read(&client, &collab).await?.data;

    // 2. 追加
    let mut doc: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "对方待办文件格式无效，请检查同步文件")?;
    let new_todo: serde_json::Value = serde_json::from_str(&todo_json)
        .map_err(|e| format!("todo JSON 无效：{e}"))?;
        
    let todos = doc["todos"].as_array_mut().ok_or("todos 字段异常")?;
    let new_id = new_todo["id"].as_str().unwrap_or("");
    if !new_id.is_empty() && todos.iter().any(|t| t["id"].as_str() == Some(new_id)) {
        // ID 重复则忽略不处理
    } else {
        todos.push(new_todo);
    }
    
    doc["last_updated"] = serde_json::Value::String(get_iso_timestamp());
    
    // 3. 上传
    let updated = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let put = client.put(&target)
        .basic_auth(&collab.webdav_username, Some(&collab.webdav_password))
        .header("Content-Type", "application/json; charset=utf-8")
        .body(updated).send().await.map_err(|_| "无法连接对方服务器，请检查地址和网络后重试。")?;
        
    collaboration_access::http_status(put.status().as_u16())
}

fn build_collab_url(collab: &CollaborationSource) -> String {
    let encoded = collab.webdav_filepath.split('/').map(|s| {
        if s.is_empty() { String::new() } else { urlencoding::encode(s).into_owned() }
    }).collect::<Vec<_>>().join("/");
    let url = &collab.webdav_url;
    if url.ends_with('/') { format!("{url}{encoded}") } else { format!("{url}/{encoded}") }
}
