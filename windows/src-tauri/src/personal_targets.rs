use super::*;

#[derive(Serialize)]
pub struct PersonalTargetRead {
    pub target: String,
    pub data: Option<String>,
    pub missing: bool,
    pub legacy_data: Option<String>,
}

fn local_path(root: &Path, config: &AppConfig) -> Result<PathBuf, String> {
    let folder = config.sync_path.as_deref().filter(|s| !s.trim().is_empty());
    if let Some(folder) = folder {
        if !Path::new(folder).is_absolute() || Path::new(folder).components().any(|p| p == std::path::Component::ParentDir) {
            return Err("同步路径必须是绝对路径且不能包含 '..'".into());
        }
    }
    Ok(folder.map(PathBuf::from).unwrap_or_else(|| root.to_path_buf()).join("todo_data.json"))
}

pub fn identity(root: &Path, config: &AppConfig) -> Result<String, String> {
    let key = if config.sync_mode.as_deref() == Some("webdav") {
        let conn = build_webdav_conn(config)?;
        if !conn.target.starts_with("https://") { return Err("WebDAV URL 必须使用 https:// 协议".into()); }
        // 密码轮换不改变数据归属；账户、服务器和文件路径共同确定身份。
        serde_json::to_string(&("webdav", conn.target, conn.user)).map_err(|e| e.to_string())?
    } else {
        let path = local_path(root, config)?;
        serde_json::to_string(&("local", path.to_string_lossy().replace('/', "\\").to_lowercase())).map_err(|e| e.to_string())?
    };
    Ok(format!("{:x}", Sha256::digest(key.as_bytes())))
}

pub fn path(root: &Path, config: &AppConfig) -> Result<PathBuf, String> {
    if config.sync_mode.as_deref() == Some("webdav") {
        Ok(root.join("personal_targets").join(identity(root, config)?).join("todo_data.json"))
    } else { local_path(root, config) }
}

fn validate(data: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(data).map_err(|e| format!("数据文件无法解析：{e}"))?;
    if !value.get("todos").is_some_and(|v| v.is_array()) { return Err("数据文件缺少任务数组".into()); }
    Ok(())
}

fn verify_owner(path: &Path, target: &str) -> Result<(), String> {
    let owner = fs::read_to_string(path.with_file_name("target.json")).map_err(|_| "缓存归属信息缺失，请重新连接目标".to_string())?;
    let owner: serde_json::Value = serde_json::from_str(&owner).map_err(|_| "缓存归属信息损坏".to_string())?;
    if owner["target"].as_str() != Some(target) { return Err("缓存与同步目标不匹配".into()); }
    Ok(())
}

pub fn read_at(root: &Path, config: &AppConfig) -> Result<PersonalTargetRead, String> {
    let target = identity(root, config)?;
    let path = path(root, config)?;
    let missing = !path.try_exists().map_err(|e| e.to_string())?;
    let data = if !missing {
        if config.sync_mode.as_deref() == Some("webdav") { verify_owner(&path, &target)?; }
        let _guard = acquire_lock(&path, false)?;
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        validate(&data)?; Some(data)
    } else if config.sync_mode.as_deref() == Some("webdav") { None }
    else { Some(r#"{"version":1,"todos":[]}"#.into()) };
    let legacy_data = if config.sync_mode.as_deref() == Some("webdav") {
        let legacy_path = local_path(root, config)?;
        match fs::read_to_string(legacy_path) {
            Ok(value) if validate(&value).is_ok() => Some(value),
            _ => None,
        }
    } else { None };
    Ok(PersonalTargetRead { target, data, missing, legacy_data })
}

// 提交顺序：目标身份 -> 目标数据 -> 激活配置。中断只会留下未激活的独立缓存。
// 旧共用缓存仅供显式导入预览，不参加自动合并，不能推断其远端归属。
pub fn stage_at(root: &Path, config: &AppConfig, data: &str) -> Result<(), String> {
    validate(data)?;
    let path = path(root, config)?;
    fs::create_dir_all(path.parent().ok_or("无效数据路径")?).map_err(|e| e.to_string())?;
    if config.sync_mode.as_deref() == Some("webdav") {
        let _guard = acquire_lock(&path, true)?;
        let owner = serde_json::json!({"version":1,"target":identity(root, config)?}).to_string();
        atomic_write(&path.with_file_name("target.json"), &owner)?;
        atomic_write(&path, data)?;
    }
    Ok(())
}

pub fn activate_at(root: &Path, config: &AppConfig, data: &str, persist_config: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    stage_at(root, config, data)?;
    persist_config()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switching_and_restarting_never_adopts_another_targets_cache() {
        let root = std::env::temp_dir().join(format!("todo-targets-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let a = AppConfig { sync_mode: Some("webdav".into()), webdav_filepath: Some("a.json".into()), ..AppConfig::default() };
        let b = AppConfig { webdav_filepath: Some("b.json".into()), ..a.clone() };
        let a_data = r#"{"todos":[{"id":"A"}],"time_entries":[{"id":"timer"}]}"#;
        fs::write(root.join("todo_data.json"), a_data).unwrap();
        // 旧版共用缓存没有身份，不能成为任意远端的离线缓存。
        assert!(read_at(&root, &b).unwrap().data.is_none());
        stage_at(&root, &a, a_data).unwrap();
        let b_path = path(&root, &b).unwrap();
        fs::create_dir_all(b_path.parent().unwrap()).unwrap();
        let owner = serde_json::json!({"target":identity(&root, &b).unwrap()}).to_string();
        // 模拟在身份写完、数据尚未写入时终止进程，再次读取只能报告未就绪。
        atomic_write(&b_path.with_file_name("target.json"), &owner).unwrap();
        assert!(read_at(&root, &b).unwrap().data.is_none());
        let b_data = r#"{"todos":[{"id":"B"}],"daily_reviews":[{"id":"review"}]}"#;
        stage_at(&root, &b, b_data).unwrap();
        let config_path = root.join("config.json");
        atomic_write(&config_path, &serde_json::to_string(&a).unwrap()).unwrap();
        // B 完整落盘后配置写入失败，重启仍能使用 A；旧缓存不改名认领。
        assert!(activate_at(&root, &b, b_data, || Err("配置提交中断".into())).is_err());
        let restarted: AppConfig = serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(read_at(&root, &restarted).unwrap().data.unwrap(), a_data);
        activate_at(&root, &b, b_data, || {
            assert_eq!(read_at(&root, &b)?.data.as_deref(), Some(b_data));
            atomic_write(&config_path, &serde_json::to_string(&b).unwrap())
        }).unwrap();
        let restarted: AppConfig = serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(read_at(&root, &restarted).unwrap().data.unwrap(), b_data);
        // 激活前/后及重复恢复均按身份读取，不依赖进程内状态。
        for _ in 0..3 {
            assert_eq!(read_at(&root, &a).unwrap().data.unwrap(), a_data);
            assert_eq!(read_at(&root, &b).unwrap().data.unwrap(), b_data);
        }
        atomic_write(&b_path.with_file_name("target.json"), "bad metadata").unwrap();
        assert!(read_at(&root, &b).is_err());
        assert_eq!(fs::read_to_string(root.join("todo_data.json")).unwrap(), a_data);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn connecting_local_folder_preserves_existing_file_and_rejects_bad_data() {
        let root = std::env::temp_dir().join(format!("todo-local-target-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let config = AppConfig { sync_mode: Some("local".into()), sync_path: Some(root.to_string_lossy().into_owned()), ..AppConfig::default() };
        let original = r#"{"todos":[{"id":"B"}],"daily_reviews":[{"fact":"保留"}]}"#;
        let file = root.join("todo_data.json");
        fs::write(&file, original).unwrap();
        stage_at(&root, &config, r#"{"todos":[{"id":"A"}]}"#).unwrap();
        assert_eq!(read_at(&root, &config).unwrap().data.unwrap(), original);
        fs::write(&file, "{bad").unwrap();
        assert!(read_at(&root, &config).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "{bad");
        fs::remove_dir_all(root).unwrap();
    }
}
