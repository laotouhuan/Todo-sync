use crate::record_journal::{
    bytes, decode_envelope, digest, encode_envelope, valid_digest, valid_uuid, Artifact,
    Dependencies, RecordIntent, RecordObservation, State,
};
use crate::todo_store::{acquire_lock, atomic_write, personal_planning_target};
use record_sync_codec_lab::{decode_canonical, time_millis};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const PROTOCOL: &str = "todo-record-sync/1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalPlanningTarget {
    dataset_id: String,
    actor_id: String,
    at: String,
}

#[tauri::command]
pub fn open_personal_planning_target(app: AppHandle, target: String) -> Result<PersonalPlanningTarget, String> {
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    if !valid_digest(&target) || personal_planning_target(&app)? != target {
        return Err("RECORD_TARGET_MISMATCH".into());
    }
    load_or_create_planning_target(&root, &target)
}

fn load_or_create_planning_target(root: &Path, target: &str) -> Result<PersonalPlanningTarget, String> {
    let directory = root.join("personal-planning");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("{target}.json"));
    let _lock = acquire_lock(&path, true)?;
    if let Some(raw) = read_current(&path)? {
        let saved: PersonalPlanningTarget = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if !valid_uuid(&saved.dataset_id) || !valid_uuid(&saved.actor_id) || time_millis(&saved.at).is_none() {
            return Err("INVALID_RECORD_TARGET".into());
        }
        return Ok(saved);
    }
    let binding = PersonalPlanningTarget {
        dataset_id: uuid::Uuid::new_v4().to_string(),
        actor_id: uuid::Uuid::new_v4().to_string(),
        at: "1970-01-01T00:00:00Z".into(),
    };
    atomic_write(&path, &serde_json::to_string(&binding).map_err(|error| error.to_string())?)?;
    Ok(binding)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetPin {
    pub(crate) protocol: String,
    pub(crate) dataset_id: String,
    pub(crate) descriptor_sha256: String,
    pub(crate) baseline_sha256: String,
    pub(crate) namespace: String,
}

impl DatasetPin {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.protocol != PROTOCOL
            || !valid_uuid(&self.dataset_id)
            || !valid_digest(&self.descriptor_sha256)
            || !valid_digest(&self.baseline_sha256)
            || self.namespace != format!("record-sync/{}/", self.dataset_id)
        {
            return Err("INVALID_DATASET_PIN".into());
        }
        Ok(())
    }

    pub(crate) fn empty_journal(&self) -> State {
        State {
            dataset_id: self.dataset_id.clone(),
            descriptor_sha256: self.descriptor_sha256.clone(),
            records: Vec::new(),
            pending: Vec::new(),
            unread: Vec::new(),
            fault: None,
            resolved_faults: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    protocol: String,
    dataset_id: String,
    baseline_sha256: String,
    data_schema_version: u32,
    operation_set: String,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Baseline {
    protocol: String,
    dataset_id: String,
    #[serde(rename = "data")]
    _data: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryRequest {
    pin: DatasetPin,
    descriptor: String,
    baseline: String,
    current: Option<String>,
    backup: Option<String>,
    #[serde(default)]
    received: Vec<Artifact>,
    #[serde(default)]
    discovered: Vec<String>,
    #[serde(default)]
    confirmed: Vec<Artifact>,
    observation: Option<RecordObservation>,
    intent: Option<RecordIntent>,
    repair: Option<RecordRepair>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordRepair {
    observed_sha256: String,
    restored: Artifact,
}

#[derive(Serialize)]
pub struct RecoveryPreview {
    operation_set: String,
    baseline: String,
    journal: State,
    dependencies: Dependencies,
    records: Option<Vec<String>>,
    submitted: Option<Artifact>,
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryReceipt {
    previous_sha256: Option<String>,
    candidate_sha256: String,
}

#[derive(Serialize)]
pub struct PreparedRecovery {
    preview: RecoveryPreview,
    receipt: RecoveryReceipt,
}

fn open_artifact(content: &str, expected_hash: &str) -> Result<String, String> {
    let raw = bytes(content)?;
    if digest(&raw) != expected_hash {
        return Err("DATASET_HASH_MISMATCH".into());
    }
    decode_canonical(&raw).map_err(str::to_owned)
}

// 仅解析显式传入的隔离数据集与日志备份。输入不含文件路径。
#[tauri::command]
pub async fn preview_record_recovery(request: RecoveryRequest) -> Result<RecoveryPreview, String> {
    preview(request)
}

#[tauri::command]
pub async fn prepare_record_recovery_commit(
    app: AppHandle,
    request: RecoveryRequest,
) -> Result<PreparedRecovery, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = journal_path(&root, &request)?;
    let _lock = acquire_lock(&path, false)?;
    let (prepared, _) = prepare(request, read_current(&path)?)?;
    Ok(prepared)
}

#[tauri::command]
pub async fn commit_record_recovery(
    app: AppHandle,
    request: RecoveryRequest,
    receipt: RecoveryReceipt,
) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = journal_path(&root, &request)?;
    commit(&path, request, receipt)
}

#[tauri::command]
pub async fn export_record_fault_evidence(app: AppHandle, pin: DatasetPin) -> Result<bool, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = journal_file(&root, &pin)?;
    let content = {
        let _lock = acquire_lock(&path, false)?;
        fault_evidence(&path, &pin)?
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出记录同步故障证据")
        .set_file_name(format!("record-fault-{}.json", pin.dataset_id))
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut output = fs::File::create_new(path).map_err(|e| e.to_string())?;
    output
        .write_all(content.as_bytes())
        .and_then(|()| output.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

fn fault_evidence(path: &Path, pin: &DatasetPin) -> Result<String, String> {
    let content = read_current(path)?.ok_or("RECORD_FAULT_NOT_FOUND")?;
    let journal = decode_envelope(content.as_bytes(), &pin.empty_journal())?;
    if journal.fault.is_none() && journal.resolved_faults.is_empty() {
        return Err("RECORD_FAULT_NOT_FOUND".into());
    }
    Ok(content)
}

fn journal_path(root: &Path, request: &RecoveryRequest) -> Result<PathBuf, String> {
    if request.current.is_some() {
        return Err("RECORD_CURRENT_MUST_COME_FROM_DISK".into());
    }
    journal_file(root, &request.pin)
}

fn journal_file(root: &Path, pin: &DatasetPin) -> Result<PathBuf, String> {
    pin.validate()?;
    let directory = root.join("record-journals");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join(format!("{}.json", pin.dataset_id)))
}

// 预览和提交均从同一目标文件读日志。旧文件字节和候选字节共同固定本次写入。
fn read_current(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn prepare(
    mut request: RecoveryRequest,
    current: Option<String>,
) -> Result<(PreparedRecovery, String), String> {
    request.current = current;
    let previous_sha256 = request.current.as_ref().map(|text| digest(text.as_bytes()));
    let preview = preview(request)?;
    let envelope = encode_envelope(&preview.journal, &preview.journal)?;
    let candidate_sha256 = digest(envelope.as_bytes());
    let receipt = RecoveryReceipt {
        previous_sha256,
        candidate_sha256,
    };
    Ok((PreparedRecovery { preview, receipt }, envelope))
}

fn commit(path: &Path, request: RecoveryRequest, receipt: RecoveryReceipt) -> Result<(), String> {
    let _lock = acquire_lock(path, true)?;
    let current = read_current(path)?;
    if current.as_ref().map(|text| digest(text.as_bytes())) != receipt.previous_sha256 {
        return Err("RECORD_RECOVERY_PREVIEW_STALE".into());
    }
    let (prepared, envelope) = prepare(request, current)?;
    if prepared.receipt != receipt {
        return Err("RECORD_RECOVERY_PREVIEW_STALE".into());
    }
    if receipt.previous_sha256.as_ref() != Some(&receipt.candidate_sha256) {
        atomic_write(path, &envelope)?;
    }
    Ok(())
}

fn preview(request: RecoveryRequest) -> Result<RecoveryPreview, String> {
    let importing = request.backup.is_some()
        || !request.received.is_empty()
        || !request.discovered.is_empty()
        || !request.confirmed.is_empty();
    if request.intent.is_some() && (importing || request.observation.is_some()) {
        return Err("RECORD_INTENT_MUST_BE_SEPARATE".into());
    }
    if importing && request.observation.is_some() {
        return Err("RECORD_OBSERVATION_MUST_BE_SEPARATE".into());
    }
    if request.repair.is_some()
        && (importing || request.observation.is_some() || request.intent.is_some())
    {
        return Err("RECORD_REPAIR_MUST_BE_SEPARATE".into());
    }
    let current_sha256 = request.current.as_ref().map(|text| digest(text.as_bytes()));
    let pin = request.pin;
    pin.validate()?;
    let descriptor: Descriptor =
        serde_json::from_str(&open_artifact(&request.descriptor, &pin.descriptor_sha256)?)
            .map_err(|e| e.to_string())?;
    let baseline_text = open_artifact(&request.baseline, &pin.baseline_sha256)?;
    let baseline: Baseline = serde_json::from_str(&baseline_text).map_err(|e| e.to_string())?;
    if descriptor.protocol != PROTOCOL
        || baseline.protocol != PROTOCOL
        || descriptor.dataset_id != pin.dataset_id
        || baseline.dataset_id != pin.dataset_id
        || descriptor.baseline_sha256 != pin.baseline_sha256
        || descriptor.data_schema_version != 1
        || time_millis(&descriptor.created_at).is_none()
    {
        return Err("INVALID_DATASET_BINDING".into());
    }
    if !matches!(
        descriptor.operation_set.as_str(),
        "lab-collaboration/1" | "lab-collaboration/2" | "lab-planning/1" | "planning/1"
    ) {
        return Err("UNSUPPORTED_RECORD_OPERATION_SET".into());
    }
    let expected = pin.empty_journal();
    let mut journal = match request.current {
        Some(current) => decode_envelope(current.as_bytes(), &expected)?,
        None => expected.clone(),
    };
    if journal.fault.is_some()
        && (request.intent.is_some() || importing || request.observation.is_some())
    {
        return Err("RECORD_DATASET_FROZEN".into());
    }
    if let Some(backup) = request.backup {
        journal.union(&decode_envelope(backup.as_bytes(), &expected)?)?;
    }
    journal.union(&State {
        records: request.received,
        ..expected.clone()
    })?;
    journal.note_discovered(request.discovered)?;
    for remote in request.confirmed {
        journal.acknowledge(&remote.name, &bytes(&remote.content)?)?;
    }
    if let Some(observation) = request.observation {
        journal.observe(observation)?;
    }
    if let Some(repair) = request.repair {
        if current_sha256.as_deref() != Some(&repair.observed_sha256) {
            return Err("RECORD_RECOVERY_PREVIEW_STALE".into());
        }
        journal.resolve_changed_object(&repair.restored)?;
    }
    let submitted = request
        .intent
        .map(|intent| journal.stage_local(intent, current_sha256.as_deref()))
        .transpose()?;
    let dependencies = journal.dependencies(&expected)?;
    let records = if dependencies.missing.is_empty() && journal.fault.is_none() {
        Some(journal.records_for_replay(&expected)?)
    } else {
        None
    };
    // 保留基线的规范字节顺序，供 WebView 与 Android 重建相同的删除预览签名。
    Ok(RecoveryPreview {
        operation_set: descriptor.operation_set,
        baseline: baseline_text,
        journal,
        dependencies,
        records,
        submitted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::json;

    #[test]
    fn personal_planning_bindings_are_stable_and_separate() {
        let root = std::env::temp_dir().join(format!("todo-planning-targets-{}", uuid::Uuid::new_v4()));
        let first = load_or_create_planning_target(&root, &"a".repeat(64)).unwrap();
        let second = load_or_create_planning_target(&root, &"b".repeat(64)).unwrap();
        let reopened = load_or_create_planning_target(&root, &"a".repeat(64)).unwrap();
        assert_eq!(reopened.dataset_id, first.dataset_id);
        assert_eq!(reopened.actor_id, first.actor_id);
        assert_ne!(second.dataset_id, first.dataset_id);
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    fn request() -> (RecoveryRequest, State) {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native-record-journal/series-causal-replay.json"
        ))
        .unwrap();
        let pin = &fixture["pin"];
        let baseline = json!({ "protocol": pin["protocol"], "dataset_id": pin["dataset_id"], "data": fixture["baseline"] });
        let raw = record_sync_codec_lab::canonicalize(&baseline.to_string()).unwrap();
        let request = serde_json::from_value(json!({
            "pin": pin, "descriptor": fixture["descriptor"]["content"], "baseline": STANDARD.encode(raw)
        })).unwrap();
        let complete = serde_json::from_value(fixture["cases"][0]["journal"].clone()).unwrap();
        (request, complete)
    }

    #[test]
    fn record_recovery_holds_child_and_restores_pending_records_from_backup() {
        let (mut first, complete) = request();
        first.received = vec![complete.records[0].clone()];
        let partial = preview(first).unwrap();
        assert!(partial.records.is_none());
        assert_eq!(
            partial.dependencies.missing,
            [complete.records[1].name.clone()]
        );

        let (mut resumed, _) = request();
        resumed.current = Some(encode_envelope(&partial.journal, &complete).unwrap());
        let backup = State {
            records: vec![complete.records[1].clone()],
            pending: vec![complete.records[1].name.clone()],
            ..complete.clone()
        };
        resumed.backup = Some(encode_envelope(&backup, &complete).unwrap());
        resumed.received = vec![complete.records[0].clone()];
        let recovered = preview(resumed).unwrap();
        assert_eq!(recovered.operation_set, "lab-collaboration/2");
        assert_eq!(recovered.journal.pending, backup.pending);
        assert_eq!(recovered.journal.records, complete.records);
        assert!(recovered.dependencies.missing.is_empty());
        assert_eq!(recovered.records.unwrap().len(), 2);
    }

    #[test]
    fn record_recovery_rejects_changed_snapshot_and_unrelated_backup() {
        let (mut changed, _) = request();
        changed.baseline = STANDARD.encode("{}");
        assert_eq!(preview(changed).err().unwrap(), "DATASET_HASH_MISMATCH");

        let (mut wrong_target, complete) = request();
        let other = State {
            dataset_id: uuid::Uuid::new_v4().to_string(),
            records: vec![],
            ..complete
        };
        wrong_target.backup = Some(encode_envelope(&other, &other).unwrap());
        assert_eq!(
            preview(wrong_target).err().unwrap(),
            "RECORD_TARGET_MISMATCH"
        );
    }

    #[test]
    fn durable_recovery_keeps_received_records_and_rejects_stale_or_failed_writes() {
        let root = std::env::temp_dir().join(format!("todo-recovery-{}", uuid::Uuid::new_v4()));
        let (mut child, complete) = request();
        child.received = vec![complete.records[0].clone()];
        let path = journal_path(&root, &child).unwrap();
        let (child_preview, _) = prepare(request_with(complete.records[0].clone()), None).unwrap();
        let (stale_parent, _) = prepare(request_with(complete.records[1].clone()), None).unwrap();
        assert!(child_preview.preview.records.is_none());
        commit(&path, child, child_preview.receipt).unwrap();
        let partial = fs::read_to_string(&path).unwrap();
        assert_eq!(
            commit(
                &path,
                request_with(complete.records[1].clone()),
                stale_parent.receipt
            )
            .unwrap_err(),
            "RECORD_RECOVERY_PREVIEW_STALE"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), partial);
        let (parent_preview, _) = prepare(
            request_with(complete.records[1].clone()),
            read_current(&path).unwrap(),
        )
        .unwrap();
        assert_eq!(parent_preview.preview.records.as_ref().unwrap().len(), 2);

        fs::create_dir(path.with_extension("tmp")).unwrap();
        assert!(commit(
            &path,
            request_with(complete.records[1].clone()),
            parent_preview.receipt
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), partial);
        fs::remove_dir(path.with_extension("tmp")).unwrap();
        let (retry, _) = prepare(
            request_with(complete.records[1].clone()),
            read_current(&path).unwrap(),
        )
        .unwrap();
        commit(
            &path,
            request_with(complete.records[1].clone()),
            retry.receipt,
        )
        .unwrap();
        let reopened = crate::record_journal::load(&path, &complete).unwrap();
        assert_eq!(reopened, complete);
        fs::remove_dir_all(root).unwrap();
    }

    fn request_with(artifact: Artifact) -> RecoveryRequest {
        let (mut input, _) = request();
        input.received.push(artifact);
        input
    }

    #[test]
    fn local_submit_reuses_canonical_bytes_and_keeps_queue_atomic() {
        let root = std::env::temp_dir().join(format!("todo-local-record-{}", uuid::Uuid::new_v4()));
        let (mut first, complete) = request();
        let path = journal_path(&root, &first).unwrap();
        let [child, parent] = complete.records.as_slice() else {
            panic!("需要两条共享记录")
        };
        first.intent = Some(intent_for(parent, None));
        let (preview, _) = prepare(first, None).unwrap();
        assert_eq!(preview.preview.submitted.as_ref(), Some(parent));
        assert_eq!(preview.preview.journal.pending, [parent.name.clone()]);
        assert!(!path.exists());

        let (mut commit_first, _) = request();
        commit_first.intent = Some(intent_for(parent, None));
        let revision = preview.receipt.candidate_sha256.clone();
        commit(&path, commit_first, preview.receipt).unwrap();

        let (mut stale_child, _) = request();
        stale_child.intent = Some(intent_for(child, None));
        assert_eq!(
            prepare(stale_child, read_current(&path).unwrap())
                .err()
                .unwrap(),
            "RECORD_WRITE_STALE"
        );

        let (mut next, _) = request();
        next.intent = Some(intent_for(child, Some(revision.clone())));
        let (child_preview, _) = prepare(next, read_current(&path).unwrap()).unwrap();
        assert_eq!(child_preview.preview.submitted.as_ref(), Some(child));
        let (mut commit_child, _) = request();
        commit_child.intent = Some(intent_for(child, Some(revision)));
        commit(&path, commit_child, child_preview.receipt).unwrap();

        let (mut retry, _) = request();
        retry.intent = Some(intent_for(parent, None));
        let (reopened, _) = prepare(retry, read_current(&path).unwrap()).unwrap();
        assert_eq!(reopened.preview.submitted.as_ref(), Some(parent));
        assert_eq!(
            reopened.preview.journal.pending,
            [parent.name.clone(), child.name.clone()]
        );
        assert_eq!(
            reopened.receipt.previous_sha256.as_ref(),
            Some(&reopened.receipt.candidate_sha256)
        );

        let (mut conflicting, _) = request();
        let mut invalid = intent_value(parent, None);
        invalid["created_at"] = json!("2026-11-12T03:00:00Z");
        conflicting.intent = Some(serde_json::from_value(invalid).unwrap());
        assert_eq!(
            prepare(conflicting, read_current(&path).unwrap())
                .err()
                .unwrap(),
            "RECORD_ID_CONTENT_CONFLICT"
        );
        fs::remove_file(&path).unwrap();
        fs::remove_file(path.with_extension("lock")).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
        fs::remove_dir(root).unwrap();
    }

    fn intent_value(artifact: &Artifact, observed: Option<String>) -> Value {
        let record: Value = serde_json::from_slice(&bytes(&artifact.content).unwrap()).unwrap();
        json!({
            "observed_sha256": observed, "id": record["id"], "actor_id": record["actor_id"],
            "created_at": record["created_at"], "operations": record["operations"]
        })
    }

    fn intent_for(artifact: &Artifact, observed: Option<String>) -> RecordIntent {
        serde_json::from_value(intent_value(artifact, observed)).unwrap()
    }

    #[test]
    fn transfer_observations_persist_unread_and_require_exact_upload_confirmation() {
        let (mut first, complete) = request();
        let child = &complete.records[0];
        let parent = &complete.records[1];
        first.discovered = vec![child.name.clone(), child.name.clone()];
        let (observed, raw) = prepare(first, None).unwrap();
        assert_eq!(observed.preview.journal.unread, [child.name.clone()]);
        let (mut received, _) = request();
        received.received.push(child.clone());
        let (partial, raw) = prepare(received, Some(raw)).unwrap();
        assert!(partial.preview.journal.unread.is_empty());
        assert_eq!(partial.preview.dependencies.missing, [parent.name.clone()]);
        let (mut backup, _) = request();
        let pending = State {
            records: vec![parent.clone()],
            pending: vec![parent.name.clone()],
            ..complete.clone()
        };
        backup.backup = Some(encode_envelope(&pending, &complete).unwrap());
        let (_, queued) = prepare(backup, Some(raw)).unwrap();
        let (mut mismatch, _) = request();
        mismatch.confirmed.push(Artifact {
            name: parent.name.clone(),
            content: child.content.clone(),
        });
        assert_eq!(
            prepare(mismatch, Some(queued.clone())).err().unwrap(),
            "RECORD_ACK_MISMATCH"
        );
        let (mut verified, _) = request();
        verified.confirmed.push(parent.clone());
        let (sent, _) = prepare(verified, Some(queued)).unwrap();
        assert!(sent.preview.journal.pending.is_empty());
        assert_eq!(sent.preview.journal.records, complete.records);
    }

    #[test]
    fn changed_object_preserves_original_and_queue_across_disk_reopen() {
        let (mut input, complete) = request();
        let root =
            std::env::temp_dir().join(format!("todo-frozen-record-{}", uuid::Uuid::new_v4()));
        let path = journal_path(&root, &input).unwrap();
        let [child, parent] = complete.records.as_slice() else {
            panic!("需要两条共享记录")
        };
        let initial = State {
            pending: vec![child.name.clone()],
            ..complete.clone()
        };
        crate::record_journal::save(&path, &initial, &complete).unwrap();
        let changed = Artifact {
            name: parent.name.clone(),
            content: child.content.clone(),
        };
        input.observation = Some(RecordObservation {
            artifact: changed.clone(),
            confirm: false,
        });
        let (mut repeated, _) = request();
        repeated.observation = Some(RecordObservation {
            artifact: changed.clone(),
            confirm: false,
        });
        let (prepared, _) = prepare(input, read_current(&path).unwrap()).unwrap();
        assert!(prepared.preview.records.is_none());
        commit(&path, repeated, prepared.receipt).unwrap();

        let (fresh, _) = request();
        let (opened, _) = prepare(fresh, read_current(&path).unwrap()).unwrap();
        let journal = opened.preview.journal;
        assert!(opened.preview.records.is_none());
        assert_eq!(journal.records, complete.records);
        assert_eq!(journal.pending, initial.pending);
        let evidence = journal.fault.unwrap();
        assert_eq!(evidence.observed, changed);
        let (exported, _) = request();
        assert_eq!(
            fault_evidence(&path, &exported.pin).unwrap(),
            fs::read_to_string(&path).unwrap()
        );
        let (mut mutation, _) = request();
        mutation.confirmed.push(child.clone());
        assert_eq!(
            prepare(mutation, read_current(&path).unwrap())
                .err()
                .unwrap(),
            "RECORD_DATASET_FROZEN"
        );
        let revision = opened.receipt.previous_sha256.unwrap();
        let repair = |restored: Artifact, observed_sha256: String| {
            let (mut input, _) = request();
            input.repair = Some(RecordRepair {
                observed_sha256,
                restored,
            });
            input
        };
        let frozen = read_current(&path).unwrap();
        for (input, code) in [
            (
                repair(changed, revision.clone()),
                "RECORD_REPAIR_BYTES_MISMATCH",
            ),
            (
                repair(parent.clone(), "0".repeat(64)),
                "RECORD_RECOVERY_PREVIEW_STALE",
            ),
        ] {
            assert_eq!(prepare(input, frozen.clone()).err().unwrap(), code);
        }
        let (repaired, _) = prepare(repair(parent.clone(), revision.clone()), frozen).unwrap();
        assert!(repaired.preview.records.is_some());
        commit(&path, repair(parent.clone(), revision), repaired.receipt).unwrap();
        let reopened = crate::record_journal::load(&path, &complete).unwrap();
        assert!(reopened.fault.is_none());
        assert_eq!(reopened.resolved_faults, [evidence]);
        assert_eq!(reopened.pending, initial.pending);
        assert_eq!(
            fault_evidence(&path, &exported.pin).unwrap(),
            fs::read_to_string(&path).unwrap()
        );
        fs::remove_file(&path).unwrap();
        fs::remove_file(path.with_extension("lock")).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn identity_or_invalid_record_fault_cannot_be_cleared_by_recheck() {
        let (_, complete) = request();
        let mut journal = complete.clone();
        journal.fault = Some(crate::record_journal::RecordFault {
            code: "RECORD_REMOTE_INVALID".into(),
            observed: complete.records[0].clone(),
        });
        assert_eq!(
            journal.resolve_changed_object(&complete.records[0]).unwrap_err(),
            "RECORD_FAULT_REQUIRES_REVIEW"
        );
        assert!(journal.fault.is_some());
    }
}
