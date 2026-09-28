//! 共享配置只包含元数据；协作密码保存在应用私有目录，不进入 WebDAV 或同步目录。
use std::path::Path;
use serde_json::{Map, Value};

fn parse(data: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    if !value.get("collaborations").map_or(false, Value::is_array) {
        return Err("协作配置格式错误".into());
    }
    if value["collaborations"].as_array().unwrap().iter().any(|item| !item.is_object()) {
        return Err("协作清单格式错误".into());
    }
    Ok(value)
}

fn identity(item: &Value) -> Result<String, String> {
    let mut parts = Vec::new();
    for field in ["id", "webdav_url", "webdav_username", "webdav_filepath"] {
        parts.push(item[field].as_str().ok_or("协作凭据缺少目标信息")?);
    }
    serde_json::to_string(&parts).map_err(|e| e.to_string())
}

fn read_private(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() { return Ok(Map::new()); }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|_| "本机协作凭据损坏，请恢复本机配置后重试".into())
}

fn clear_passwords(value: &mut Value) {
    for item in value["collaborations"].as_array_mut().unwrap() {
        item["webdav_password"] = Value::String(String::new());
    }
}

pub(super) fn shared(data: &str) -> Result<String, String> {
    let mut value = parse(data)?;
    clear_passwords(&mut value);
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

/// 先可靠保存本机密码，调用方才可用返回的脱敏数据替换共享文件。
pub(super) fn save_and_redact(data: &str, private_path: &Path, key: &[u8; 32]) -> Result<String, String> {
    let value = parse(data)?;
    let _guard = super::acquire_lock(private_path, true)?;
    let mut credentials = read_private(private_path)?;
    let mut changed = false;
    for item in value["collaborations"].as_array().unwrap() {
        if let Some(password) = item["webdav_password"].as_str().filter(|p| !p.is_empty()) {
            let id = identity(item)?;
            let encrypted = if password.starts_with("ENC:") {
                password.to_string()
            } else {
                super::encrypt_password_with_key(key, password)
            };
            if credentials.get(&id).and_then(Value::as_str) != Some(encrypted.as_str()) {
                credentials.insert(id, Value::String(encrypted));
                changed = true;
            }
        }
    }
    if changed {
        let serialized = serde_json::to_string_pretty(&credentials).map_err(|e| e.to_string())?;
        super::atomic_write(private_path, &serialized)?;
    }
    shared(data)
}

pub(super) fn restore(data: &str, private_path: &Path) -> Result<String, String> {
    let mut value = parse(data)?;
    let _guard = super::acquire_lock(private_path, false)?;
    let credentials = read_private(private_path)?;
    clear_passwords(&mut value);
    for item in value["collaborations"].as_array_mut().unwrap() {
        // 地址、账号或文件路径变化时，不复用旧目标的密码。
        if let Ok(id) = identity(item) {
            if let Some(password) = credentials.get(&id) {
                item["webdav_password"] = password.clone();
            }
        }
    }
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: [u8; 32] = [17; 32];

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("todo-credentials-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn private_path(&self) -> std::path::PathBuf { self.0.join("private.json") }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    fn data() -> Value {
        serde_json::json!({"version":1,"last_updated":"2026-09-28T00:00:00Z","collaborations":[
            {"id":"a","name":"测试","webdav_url":"https://example.invalid/","webdav_username":"dummy-user",
             "webdav_filepath":"todo.json","webdav_password":"dummy-secret","deleted":false},
            {"id":"b","name":"已删除","webdav_url":"https://example.invalid/","webdav_username":"dummy-user",
             "webdav_filepath":"todo.json","webdav_password":"dummy-deleted-secret","deleted":true}
        ]})
    }

    #[test]
    fn plaintext_and_encrypted_passwords_are_never_shared_even_in_tombstones() {
        let mut value = data();
        value["collaborations"][1]["webdav_password"] = Value::String(
            super::super::encrypt_password_with_key(&KEY, "dummy-deleted-secret"));
        let shared = shared(&value.to_string()).unwrap();
        assert!(!shared.contains("dummy-secret"));
        assert!(!shared.contains("ENC:"));
        let parsed: Value = serde_json::from_str(&shared).unwrap();
        assert_eq!(parsed["collaborations"][1]["webdav_password"], "");
        assert_eq!(parsed["collaborations"][1]["deleted"], true);
    }

    #[test]
    fn migration_saves_private_encrypted_credentials_and_survives_restart() {
        let fixture = Fixture::new();
        let path = fixture.private_path();
        let clean = save_and_redact(&data().to_string(), &path, &KEY).unwrap();
        assert!(!clean.contains("dummy-secret"));
        assert!(!std::fs::read_to_string(&path).unwrap().contains("dummy-secret"));
        let restored: Value = serde_json::from_str(&restore(&clean, &path).unwrap()).unwrap();
        let stored = restored["collaborations"][0]["webdav_password"].as_str().unwrap();
        assert_eq!(super::super::decrypt_password_with_key(&KEY, stored), "dummy-secret");
        // 再次保存云端空密码配置不得清空本机凭据。
        let before = std::fs::read(&path).unwrap();
        save_and_redact(&clean, &path, &KEY).unwrap();
        assert_eq!(before, std::fs::read(&path).unwrap());
    }

    #[test]
    fn target_changes_and_new_devices_cannot_reuse_credentials() {
        let fixture = Fixture::new();
        let path = fixture.private_path();
        let clean = save_and_redact(&data().to_string(), &path, &KEY).unwrap();
        for field in ["id", "webdav_url", "webdav_username", "webdav_filepath"] {
            let mut changed: Value = serde_json::from_str(&clean).unwrap();
            changed["collaborations"][0][field] = Value::String("different".into());
            let restored: Value = serde_json::from_str(&restore(&changed.to_string(), &path).unwrap()).unwrap();
            assert_eq!(restored["collaborations"][0]["webdav_password"], "", "{field}");
        }
        let other = Fixture::new();
        let restored: Value = serde_json::from_str(&restore(&data().to_string(), &other.private_path()).unwrap()).unwrap();
        assert_eq!(restored["collaborations"][0]["webdav_password"], "");
    }

    #[test]
    fn failed_private_save_or_corrupt_store_aborts_migration() {
        let fixture = Fixture::new();
        let path = fixture.private_path();
        std::fs::create_dir(&path).unwrap();
        assert!(save_and_redact(&data().to_string(), &path, &KEY).is_err());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "invalid-json").unwrap();
        assert!(save_and_redact(&data().to_string(), &path, &KEY).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid-json");
    }

    #[test]
    fn malformed_shared_data_is_rejected() {
        for input in ["{}", "{\"collaborations\":null}", "{\"collaborations\":[null]}"] {
            assert!(shared(input).is_err());
        }
    }
}
