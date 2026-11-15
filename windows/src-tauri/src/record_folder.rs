use crate::{
    record_journal::{bytes, digest, valid_record_name, Artifact},
    record_recovery::DatasetPin,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderBinding {
    root: PathBuf,
    pin: DatasetPin,
}

#[derive(Serialize)]
pub struct FolderListing {
    names: Vec<String>,
    aliases: Vec<Artifact>,
}

fn link_like(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn checked_directory(path: &Path) -> Result<(), String> {
    let info = fs::symlink_metadata(path).map_err(|_| "RECORD_FOLDER_UNAVAILABLE")?;
    if !info.is_dir() || link_like(&info) {
        return Err("RECORD_FOLDER_UNSAFE_ENTRY".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_record_sandbox_folder(
    app: tauri::AppHandle,
    pin: DatasetPin,
    descriptor: String,
    baseline: String,
) -> Result<PathBuf, String> {
    use tauri::Manager;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("record-sandbox");
    tauri::async_runtime::spawn_blocking(move || prepare_sandbox_folder(root, pin, descriptor, baseline))
        .await
        .map_err(|_| "RECORD_FOLDER_WRITE_FAILED")?
}

fn prepare_sandbox_folder(root: PathBuf, pin: DatasetPin, descriptor: String, baseline: String) -> Result<PathBuf, String> {
    pin.validate()?;
    let fixed = [
        ("baseline", &pin.baseline_sha256, bytes(&baseline)?),
        ("dataset", &pin.descriptor_sha256, bytes(&descriptor)?),
    ];
    if fixed.iter().any(|(_, hash, raw)| raw.len() as u64 > MAX_BYTES || digest(raw) != **hash) {
        return Err("RECORD_FOLDER_TARGET_MISMATCH".into());
    }
    let namespace = root.join("record-sync");
    let dataset = namespace.join(&pin.dataset_id);
    let staging = dataset.join(".staging");
    for directory in [&root, &namespace, &dataset, &dataset.join("records"), &staging] {
        match fs::create_dir(directory) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.to_string()),
        }
        checked_directory(directory)?;
    }
    for (kind, hash, raw) in fixed {
        let destination = dataset.join(format!("{kind}.{hash}.json"));
        if let Some(previous) = read_file(&destination)? {
            if previous != raw {
                return Err("RECORD_FOLDER_CONTENT_CONFLICT".into());
            }
        } else {
            publish(&staging, &destination, &raw)?;
        }
    }
    Ok(root)
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let info = match fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("RECORD_FOLDER_READ_FAILED".into()),
    };
    if !info.is_file() || link_like(&info) {
        return Err("RECORD_FOLDER_UNSAFE_ENTRY".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options
        .open(path)
        .map_err(|_| "RECORD_FOLDER_READ_FAILED")?;
    let opened = file.metadata().map_err(|_| "RECORD_FOLDER_READ_FAILED")?;
    if !opened.is_file() || link_like(&opened) {
        return Err("RECORD_FOLDER_UNSAFE_ENTRY".into());
    }
    let mut raw = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "RECORD_FOLDER_READ_FAILED")?;
    if raw.len() as u64 > MAX_BYTES {
        return Err("RECORD_FOLDER_SIZE_LIMIT".into());
    }
    Ok(Some(raw))
}

fn dataset_directory(binding: &FolderBinding) -> Result<PathBuf, String> {
    binding.pin.validate()?;
    if !binding.root.is_absolute() {
        return Err("RECORD_FOLDER_INVALID_ROOT".into());
    }
    let root = binding
        .root
        .canonicalize()
        .map_err(|_| "RECORD_FOLDER_UNAVAILABLE")?;
    let namespace = root.join("record-sync");
    checked_directory(&namespace)?;
    let dataset = namespace.join(&binding.pin.dataset_id);
    checked_directory(&dataset)?;
    for (kind, hash) in [
        ("dataset", &binding.pin.descriptor_sha256),
        ("baseline", &binding.pin.baseline_sha256),
    ] {
        let raw = read_file(&dataset.join(format!("{kind}.{hash}.json")))?
            .ok_or("RECORD_FOLDER_TARGET_MISMATCH")?;
        if digest(&raw) != *hash {
            return Err("RECORD_FOLDER_TARGET_MISMATCH".into());
        }
    }
    checked_directory(&dataset.join("records"))?;
    Ok(dataset)
}

fn checked_artifact(pin: &DatasetPin, name: String, raw: &[u8]) -> Result<Artifact, String> {
    let artifact = Artifact {
        name,
        content: STANDARD.encode(raw),
    };
    let mut journal = pin.empty_journal();
    journal.records.push(artifact.clone());
    journal
        .dependencies(&journal)
        .map_err(|_| "RECORD_FOLDER_INVALID_RECORD")?;
    Ok(artifact)
}

#[tauri::command]
pub async fn list_record_folder(binding: FolderBinding) -> Result<FolderListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_folder(binding))
        .await
        .map_err(|_| "RECORD_FOLDER_READ_FAILED")?
}

fn list_folder(binding: FolderBinding) -> Result<FolderListing, String> {
    let records = dataset_directory(&binding)?.join("records");
    let mut listing = FolderListing {
        names: vec![],
        aliases: vec![],
    };
    for entry in fs::read_dir(&records).map_err(|_| "RECORD_FOLDER_READ_FAILED")? {
        let entry = entry.map_err(|_| "RECORD_FOLDER_READ_FAILED")?;
        let file_name = entry.file_name();
        let file_name = file_name.to_str().ok_or("RECORD_FOLDER_UNRESOLVED_ENTRY")?;
        let info = fs::symlink_metadata(entry.path()).map_err(|_| "RECORD_FOLDER_READ_FAILED")?;
        if !info.is_file() || link_like(&info) {
            return Err("RECORD_FOLDER_UNSAFE_ENTRY".into());
        }
        let name = format!("records/{file_name}");
        if valid_record_name(&name) {
            listing.names.push(name);
            continue;
        }
        let raw = read_file(&entry.path())?.ok_or("RECORD_FOLDER_READ_FAILED")?;
        let value: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| "RECORD_FOLDER_UNRESOLVED_ENTRY")?;
        let id = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or("RECORD_FOLDER_UNRESOLVED_ENTRY")?;
        let name = format!("records/{id}.{}.json", digest(&raw));
        let artifact = checked_artifact(&binding.pin, name.clone(), &raw)?;
        listing.names.push(name);
        listing.aliases.push(artifact);
    }
    listing.names.sort();
    listing.names.dedup();
    Ok(listing)
}

#[tauri::command]
pub async fn read_record_folder(
    binding: FolderBinding,
    name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_folder(binding, name))
        .await
        .map_err(|_| "RECORD_FOLDER_READ_FAILED")?
}

fn read_folder(binding: FolderBinding, name: String) -> Result<Option<String>, String> {
    if !valid_record_name(&name) {
        return Err("RECORD_INVALID_REMOTE_NAME".into());
    }
    let path = dataset_directory(&binding)?.join(&name);
    // 日志负责核对字节并在不匹配时保留原始证据。
    Ok(read_file(&path)?.map(|raw| STANDARD.encode(raw)))
}

#[tauri::command]
pub async fn write_record_folder(
    binding: FolderBinding,
    name: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_folder(binding, name, content))
        .await
        .map_err(|_| "RECORD_FOLDER_WRITE_FAILED")?
}

fn write_folder(binding: FolderBinding, name: String, content: String) -> Result<(), String> {
    if !valid_record_name(&name) {
        return Err("RECORD_INVALID_REMOTE_NAME".into());
    }
    let raw = bytes(&content)?;
    checked_artifact(&binding.pin, name.clone(), &raw)?;
    let dataset = dataset_directory(&binding)?;
    let staging = dataset.join(".staging");
    match fs::create_dir(&staging) {
        Ok(()) => (),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
        Err(_) => return Err("RECORD_FOLDER_WRITE_FAILED".into()),
    }
    checked_directory(&staging)?;
    publish(&staging, &dataset.join(name), &raw)
}

fn publish(staging: &Path, destination: &Path, raw: &[u8]) -> Result<(), String> {
    let temp = staging.join(Uuid::new_v4().to_string());
    let mut file = File::create_new(&temp).map_err(|_| "RECORD_FOLDER_WRITE_FAILED")?;
    let result = (|| {
        file.write_all(raw)
            .and_then(|()| file.sync_all())
            .map_err(|_| "RECORD_FOLDER_WRITE_FAILED")?;
        drop(file);
        match fs::hard_link(&temp, destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if read_file(destination)?.as_deref() == Some(raw) {
                    Ok(())
                } else {
                    Err("RECORD_FOLDER_CONTENT_CONFLICT".into())
                }
            }
            Err(_) => Err("RECORD_FOLDER_PUBLISH_FAILED".into()),
        }
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn sandbox_reopens_fixed_objects_and_rejects_changed_bytes() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native-record-journal/series-causal-replay.json"
        )).unwrap();
        let root = std::env::temp_dir().join(format!("todo-record-sandbox-{}", Uuid::new_v4()));
        let pin = || serde_json::from_value::<DatasetPin>(fixture["pin"].clone()).unwrap();
        let baseline = record_sync_codec_lab::canonicalize(&json!({
            "data": fixture["baseline"], "dataset_id": fixture["pin"]["dataset_id"], "protocol": fixture["pin"]["protocol"]
        }).to_string()).unwrap();
        let open = || prepare_sandbox_folder(root.clone(), pin(),
            fixture["descriptor"]["content"].as_str().unwrap().into(), STANDARD.encode(&baseline));
        assert_eq!(open().unwrap(), root);
        assert_eq!(open().unwrap(), root);
        let dataset = root.join("record-sync").join(&pin().dataset_id);
        let fixed = dataset.join(fixture["descriptor"]["name"].as_str().unwrap());
        fs::write(&fixed, b"changed").unwrap();
        assert_eq!(open().unwrap_err(), "RECORD_FOLDER_CONTENT_CONFLICT");
        assert_eq!(fs::read(&fixed).unwrap(), b"changed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_transport_publishes_without_replacing_and_recovers_conflict_copy() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native-record-journal/series-causal-replay.json"
        ))
        .unwrap();
        let pin = &fixture["pin"];
        let root = std::env::temp_dir().join(format!("todo-folder-records-{}", Uuid::new_v4()));
        let make_binding = || {
            serde_json::from_value::<FolderBinding>(json!({ "root": root, "pin": pin })).unwrap()
        };
        let dataset = root
            .join("record-sync")
            .join(pin["dataset_id"].as_str().unwrap());
        let records = dataset.join("records");
        fs::create_dir_all(&records).unwrap();
        let descriptor = dataset.join(fixture["descriptor"]["name"].as_str().unwrap());
        fs::write(
            &descriptor,
            bytes(fixture["descriptor"]["content"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let baseline = json!({"protocol": pin["protocol"], "dataset_id": pin["dataset_id"], "data": fixture["baseline"]});
        fs::write(
            dataset.join(format!(
                "baseline.{}.json",
                pin["baseline_sha256"].as_str().unwrap()
            )),
            record_sync_codec_lab::canonicalize(&baseline.to_string()).unwrap(),
        )
        .unwrap();
        let parent: Artifact =
            serde_json::from_value(fixture["cases"][0]["journal"]["records"][1].clone()).unwrap();

        assert!(list_folder(make_binding()).unwrap().names.is_empty());
        assert!(read_folder(make_binding(), parent.name.clone())
            .unwrap()
            .is_none());
        write_folder(make_binding(), parent.name.clone(), parent.content.clone()).unwrap();
        write_folder(make_binding(), parent.name.clone(), parent.content.clone()).unwrap();
        assert_eq!(
            read_folder(make_binding(), parent.name.clone()).unwrap(),
            Some(parent.content.clone())
        );

        let path = dataset.join(&parent.name);
        let alias = records.join("记录（同步冲突）.json");
        fs::rename(&path, &alias).unwrap();
        let listing = list_folder(make_binding()).unwrap();
        assert_eq!(listing.names, [parent.name.clone()]);
        assert_eq!(listing.aliases, [parent.clone()]);
        fs::write(&path, "已有不同正文").unwrap();
        assert_eq!(
            write_folder(make_binding(), parent.name.clone(), parent.content).unwrap_err(),
            "RECORD_FOLDER_CONTENT_CONFLICT"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "已有不同正文");
        assert!(alias.exists());
        assert_eq!(
            read_folder(make_binding(), "../other".into()).unwrap_err(),
            "RECORD_INVALID_REMOTE_NAME"
        );
        fs::write(descriptor, b"changed").unwrap();
        assert_eq!(
            list_folder(make_binding()).err().unwrap(),
            "RECORD_FOLDER_TARGET_MISMATCH"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
