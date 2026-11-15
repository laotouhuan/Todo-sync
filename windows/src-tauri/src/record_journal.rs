use crate::todo_store::atomic_write;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use uuid::Uuid;

const FORMAT: &str = "lab-native-journal/1";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub dataset_id: String,
    pub descriptor_sha256: String,
    pub records: Vec<Artifact>,
    pub pending: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unread: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fault: Option<RecordFault>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved_faults: Vec<RecordFault>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordFault {
    pub code: String,
    pub observed: Artifact,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordObservation {
    pub artifact: Artifact,
    pub confirm: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    sha256: String,
    payload: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Parent {
    id: String,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    protocol: String,
    dataset_id: String,
    descriptor_sha256: String,
    id: String,
    actor_id: String,
    parents: Vec<Parent>,
    lamport: u64,
    created_at: String,
    operations: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordIntent {
    pub observed_sha256: Option<String>,
    id: String,
    actor_id: String,
    created_at: String,
    operations: Vec<serde_json::Value>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Dependencies {
    pub ready: Vec<String>,
    pub missing: Vec<String>,
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn bytes(text: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD.decode(text).map_err(|e| e.to_string())?;
    if STANDARD.encode(&bytes) != text {
        return Err("RECORD_NONCANONICAL_BASE64".into());
    }
    Ok(bytes)
}

pub(crate) fn valid_uuid(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|uuid| {
        uuid.get_version_num() == 4
            && uuid.get_variant() == uuid::Variant::RFC4122
            && uuid.to_string() == id
    })
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn valid_record_name(name: &str) -> bool {
    name.strip_prefix("records/")
        .and_then(|name| name.strip_suffix(".json"))
        .and_then(|name| name.split_once('.'))
        .is_some_and(|(id, hash)| valid_uuid(id) && valid_digest(hash))
}

impl State {
    pub fn stage_local(
        &mut self,
        intent: RecordIntent,
        current_sha256: Option<&str>,
    ) -> Result<Artifact, String> {
        use record_sync_codec_lab::{canonicalize, time_millis};

        if !valid_uuid(&intent.id)
            || !valid_uuid(&intent.actor_id)
            || time_millis(&intent.created_at).is_none()
            || intent.operations.is_empty()
            || intent
                .observed_sha256
                .as_deref()
                .is_some_and(|hash| !valid_digest(hash))
        {
            return Err("INVALID_RECORD_INTENT".into());
        }
        let dependencies = self.dependencies(self)?;
        let mut parents = BTreeMap::new();
        let mut referenced = BTreeSet::new();
        let mut maximum = 0;
        for artifact in &self.records {
            let raw = bytes(&artifact.content)?;
            let record: Record = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            if record.id == intent.id {
                let left = serde_json::to_string(&record.operations).map_err(|e| e.to_string())?;
                let right = serde_json::to_string(&intent.operations).map_err(|e| e.to_string())?;
                if record.actor_id != intent.actor_id
                    || record.created_at != intent.created_at
                    || canonicalize(&left)? != canonicalize(&right)?
                {
                    return Err("RECORD_ID_CONTENT_CONFLICT".into());
                }
                return Ok(artifact.clone());
            }
            maximum = maximum.max(record.lamport);
            referenced.extend(record.parents.into_iter().map(|parent| parent.id));
            parents.insert(record.id, digest(&raw));
        }
        if intent.observed_sha256.as_deref() != current_sha256 {
            return Err("RECORD_WRITE_STALE".into());
        }
        if !dependencies.missing.is_empty() {
            return Err("RECORD_DEPENDENCIES_MISSING".into());
        }
        let record = Record {
            protocol: "todo-record-sync/1".into(),
            dataset_id: self.dataset_id.clone(),
            descriptor_sha256: self.descriptor_sha256.clone(),
            id: intent.id,
            actor_id: intent.actor_id,
            parents: parents
                .into_iter()
                .filter(|(id, _)| !referenced.contains(id))
                .map(|(id, sha256)| Parent { id, sha256 })
                .collect(),
            lamport: maximum + 1,
            created_at: intent.created_at,
            operations: intent.operations,
        };
        let json = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        let raw = canonicalize(&json)?;
        let artifact = Artifact {
            name: format!("records/{}.{}.json", record.id, digest(raw.as_bytes())),
            content: STANDARD.encode(raw.as_bytes()),
        };
        self.union(&State {
            dataset_id: self.dataset_id.clone(),
            descriptor_sha256: self.descriptor_sha256.clone(),
            records: vec![artifact.clone()],
            pending: vec![artifact.name.clone()],
            unread: vec![],
            fault: None,
            resolved_faults: vec![],
        })?;
        Ok(artifact)
    }

    /// 只在所有精确依赖齐全时交给业务投影，并保留记录原始 UTF-8 内容。
    pub fn records_for_replay(&self, expected: &Self) -> Result<Vec<String>, String> {
        if self.fault.is_some() {
            return Err("RECORD_DATASET_FROZEN".into());
        }
        let dependencies = self.dependencies(expected)?;
        if !dependencies.missing.is_empty() {
            return Err("RECORD_DEPENDENCIES_MISSING".into());
        }
        let by_name: BTreeMap<_, _> = self
            .records
            .iter()
            .map(|item| (&item.name, &item.content))
            .collect();
        dependencies
            .ready
            .iter()
            .map(|name| String::from_utf8(bytes(by_name[name])?).map_err(|e| e.to_string()))
            .collect()
    }

    pub fn dependencies(&self, expected: &Self) -> Result<Dependencies, String> {
        if self.dataset_id != expected.dataset_id
            || self.descriptor_sha256 != expected.descriptor_sha256
            || !valid_uuid(&self.dataset_id)
            || !valid_digest(&self.descriptor_sha256)
        {
            return Err("RECORD_TARGET_MISMATCH".into());
        }
        for fault in self.fault.iter().chain(&self.resolved_faults) {
            if !matches!(
                fault.code.as_str(),
                "RECORD_REMOTE_BYTES_CHANGED" | "RECORD_REMOTE_INVALID"
            ) || !valid_record_name(&fault.observed.name)
                || bytes(&fault.observed.content)?.len() > 1024 * 1024
            {
                return Err("RECORD_INVALID_FAULT".into());
            }
        }
        let mut records = BTreeMap::new();
        let mut artifact_names = BTreeSet::new();
        for artifact in &self.records {
            let raw = bytes(&artifact.content)?;
            if raw.len() > 1024 * 1024 {
                return Err("RECORD_SIZE_LIMIT".into());
            }
            let canonical = record_sync_codec_lab::decode_canonical(&raw).map_err(str::to_owned)?;
            let record: Record = serde_json::from_str(&canonical).map_err(|e| e.to_string())?;
            if record.protocol != "todo-record-sync/1"
                || !valid_uuid(&record.id)
                || !valid_uuid(&record.actor_id)
                || record.dataset_id != self.dataset_id
                || record.descriptor_sha256 != self.descriptor_sha256
                || record.created_at.is_empty()
                || !(1..=9_007_199_254_740_991).contains(&record.lamport)
                || record.operations.is_empty()
                || record.operations.iter().any(|op| {
                    op.get("type")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(str::is_empty)
                })
                || artifact.name != format!("records/{}.{}.json", record.id, digest(&raw))
            {
                return Err("RECORD_INVALID_OR_DUPLICATE".into());
            }
            let mut previous = "";
            for parent in &record.parents {
                if parent.id.as_str() <= previous
                    || parent.id == record.id
                    || !valid_uuid(&parent.id)
                    || !valid_digest(&parent.sha256)
                {
                    return Err("RECORD_INVALID_PARENT".into());
                }
                previous = &parent.id;
            }
            if records
                .insert(record.id.clone(), (record, &artifact.name))
                .is_some()
            {
                return Err("RECORD_INVALID_OR_DUPLICATE".into());
            }
            artifact_names.insert(&artifact.name);
        }
        let mut pending = BTreeSet::new();
        if self
            .pending
            .iter()
            .any(|name| !pending.insert(name) || !artifact_names.contains(name))
        {
            return Err("RECORD_PENDING_WITHOUT_ARTIFACT".into());
        }
        let mut unread = BTreeSet::new();
        if self.unread.iter().any(|name| {
            !valid_record_name(name) || !unread.insert(name) || artifact_names.contains(name)
        }) {
            return Err("RECORD_INVALID_UNREAD_NAME".into());
        }
        let mut ordered: Vec<_> = records.values().collect();
        ordered.sort_by(|(a, _), (b, _)| {
            (a.lamport, &a.actor_id, &a.id).cmp(&(b.lamport, &b.actor_id, &b.id))
        });
        let mut available = BTreeSet::new();
        let mut ready = Vec::new();
        let mut missing = BTreeSet::new();
        for (record, name) in ordered {
            let mut complete = true;
            let mut maximum = 0;
            for parent in &record.parents {
                let expected = format!("records/{}.{}.json", parent.id, parent.sha256);
                if let Some((actual, actual_name)) = records.get(&parent.id) {
                    if **actual_name != expected {
                        return Err("RECORD_PARENT_HASH_CONFLICT".into());
                    }
                    if actual.lamport >= record.lamport {
                        return Err("RECORD_INVALID_PARENT_CLOCK".into());
                    }
                    complete &= available.contains(&parent.id);
                    maximum = maximum.max(actual.lamport);
                } else {
                    missing.insert(expected);
                    complete = false;
                }
            }
            if complete {
                if record.lamport != maximum + 1 {
                    return Err("RECORD_INVALID_PARENT_CLOCK".into());
                }
                available.insert(record.id.clone());
                ready.push((*name).clone());
            }
        }
        Ok(Dependencies {
            ready,
            missing: missing.into_iter().collect(),
        })
    }

    pub fn union(&mut self, other: &Self) -> Result<(), String> {
        other.dependencies(self)?;
        let mut next = self.clone();
        if next.fault.is_none() {
            next.fault.clone_from(&other.fault);
        }
        for fault in &other.resolved_faults {
            if !next.resolved_faults.contains(fault) {
                next.resolved_faults.push(fault.clone());
            }
        }
        for artifact in &other.records {
            if !next.records.contains(artifact) {
                next.records.push(artifact.clone());
            }
        }
        for name in &other.pending {
            if !next.pending.contains(name) {
                next.pending.push(name.clone());
            }
        }
        next.unread.extend(other.unread.iter().cloned());
        next.unread.sort();
        next.unread.dedup();
        let known: BTreeSet<_> = next.records.iter().map(|artifact| &artifact.name).collect();
        next.unread.retain(|name| !known.contains(name));
        next.dependencies(self)?;
        *self = next;
        Ok(())
    }

    pub fn acknowledge(&mut self, name: &str, remote: &[u8]) -> Result<(), String> {
        let stored = self
            .records
            .iter()
            .find(|item| item.name == name)
            .ok_or("RECORD_NOT_FOUND")?;
        if bytes(&stored.content)? != remote {
            return Err("RECORD_ACK_MISMATCH".into());
        }
        self.pending.retain(|item| item != name);
        Ok(())
    }

    pub fn observe(&mut self, observation: RecordObservation) -> Result<(), String> {
        let artifact = observation.artifact;
        if !valid_record_name(&artifact.name) || bytes(&artifact.content)?.len() > 1024 * 1024 {
            return Err("RECORD_INVALID_OBSERVATION".into());
        }
        let code = if let Some(local) = self.records.iter().find(|item| item.name == artifact.name)
        {
            if local.content == artifact.content {
                if observation.confirm {
                    self.pending.retain(|name| name != &artifact.name);
                }
                return Ok(());
            }
            "RECORD_REMOTE_BYTES_CHANGED"
        } else {
            if observation.confirm {
                return Err("RECORD_NOT_FOUND".into());
            }
            let incoming = Self {
                dataset_id: self.dataset_id.clone(),
                descriptor_sha256: self.descriptor_sha256.clone(),
                records: vec![artifact.clone()],
                pending: vec![],
                unread: vec![],
                fault: None,
                resolved_faults: vec![],
            };
            if self.union(&incoming).is_ok() {
                return Ok(());
            }
            "RECORD_REMOTE_INVALID"
        };
        self.fault = Some(RecordFault {
            code: code.into(),
            observed: artifact,
        });
        Ok(())
    }

    pub fn resolve_changed_object(&mut self, restored: &Artifact) -> Result<(), String> {
        let fault = self.fault.as_ref().ok_or("RECORD_FAULT_NOT_FOUND")?;
        if fault.code != "RECORD_REMOTE_BYTES_CHANGED" {
            return Err("RECORD_FAULT_REQUIRES_REVIEW".into());
        }
        if restored.name != fault.observed.name || !self.records.contains(restored) {
            return Err("RECORD_REPAIR_BYTES_MISMATCH".into());
        }
        let fault = self.fault.take().unwrap();
        if !self.resolved_faults.contains(&fault) {
            self.resolved_faults.push(fault);
        }
        Ok(())
    }

    pub fn note_discovered(&mut self, names: Vec<String>) -> Result<(), String> {
        if names.iter().any(|name| !valid_record_name(name)) {
            return Err("RECORD_INVALID_REMOTE_NAME".into());
        }
        let known: BTreeSet<_> = self.records.iter().map(|artifact| &artifact.name).collect();
        self.unread
            .extend(names.into_iter().filter(|name| !known.contains(name)));
        self.unread.sort();
        self.unread.dedup();
        Ok(())
    }
}

// 调用方串行化目标操作；记录和队列共用一次原子写入。
pub fn save(path: &Path, state: &State, expected: &State) -> Result<(), String> {
    atomic_write(path, &encode_envelope(state, expected)?)
}

pub(crate) fn encode_envelope(state: &State, expected: &State) -> Result<String, String> {
    state.dependencies(expected)?;
    let payload = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    let envelope = Envelope {
        format: FORMAT.into(),
        sha256: digest(&payload),
        payload: STANDARD.encode(payload),
    };
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

pub fn load(path: &Path, expected: &State) -> Result<State, String> {
    let text = fs::read(path).map_err(|e| e.to_string())?;
    decode_envelope(&text, expected)
}

pub(crate) fn decode_envelope(text: &[u8], expected: &State) -> Result<State, String> {
    let envelope: Envelope = serde_json::from_slice(text).map_err(|e| e.to_string())?;
    let payload = bytes(&envelope.payload)?;
    if envelope.format != FORMAT || digest(&payload) != envelope.sha256 {
        return Err("RECORD_JOURNAL_CORRUPT".into());
    }
    let state: State = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
    state.dependencies(expected)?;
    Ok(state)
}

#[test]
fn native_record_journal_retains_exact_bytes_pending_and_old_backup_union() {
    let fixture: State = serde_json::from_str(include_str!(
        "../../../tests/fixtures/native-record-journal/business.json"
    ))
    .unwrap();
    fixture.dependencies(&fixture).unwrap();
    let root = std::env::temp_dir().join(format!("todo-record-journal-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("journal.json");
    let backup = root.join("backup.json");
    let mut state = fixture.clone();
    state.records.truncate(1);
    save(&backup, &state, &fixture).unwrap();
    save(&path, &state, &fixture).unwrap();
    state.records.extend_from_slice(&fixture.records[1..]);
    state.pending = state.records[1..]
        .iter()
        .map(|row| row.name.clone())
        .collect();

    // 确认失败后仍可读回上一份提交；不发布未落盘的队列。
    fs::create_dir(path.with_extension("tmp")).unwrap();
    assert!(save(&path, &state, &fixture).is_err());
    assert_eq!(load(&path, &fixture).unwrap().records.len(), 1);
    fs::remove_dir(path.with_extension("tmp")).unwrap();
    save(&path, &state, &fixture).unwrap();

    let mut reopened = load(&path, &fixture).unwrap();
    assert_eq!(reopened, state);
    reopened.union(&load(&backup, &fixture).unwrap()).unwrap();
    assert_eq!(reopened, state);
    let name = state.pending[0].clone();
    assert!(reopened.acknowledge(&name, b"not the same").is_err());
    assert_eq!(reopened.pending, state.pending);
    reopened
        .acknowledge(&name, &bytes(&fixture.records[1].content).unwrap())
        .unwrap();
    save(&path, &reopened, &fixture).unwrap();
    assert_eq!(load(&path, &fixture).unwrap().pending, state.pending[1..]);
    assert_eq!(load(&path, &fixture).unwrap().records, fixture.records);
    let mut wrong = fixture.clone();
    wrong.descriptor_sha256 = "0".repeat(64);
    assert!(load(&path, &wrong).is_err());
    let mut corrupt: Envelope = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    corrupt.sha256 = "0".repeat(64);
    fs::write(&path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
    assert!(load(&path, &fixture).is_err());
    fs::remove_file(path).unwrap();
    fs::remove_file(backup).unwrap();
    fs::remove_dir(root).unwrap();
}

#[test]
fn native_record_dependencies_hold_child_until_exact_parent_arrives() {
    let fixture: State = serde_json::from_str(include_str!(
        "../../../tests/fixtures/native-record-journal/business.json"
    ))
    .unwrap();
    let mut partial = fixture.clone();
    partial.records.remove(0);
    assert_eq!(
        partial.dependencies(&fixture).unwrap(),
        Dependencies {
            ready: vec![fixture.records[1].name.clone()],
            missing: vec![fixture.records[0].name.clone()],
        }
    );
    assert_eq!(
        partial.records_for_replay(&fixture).unwrap_err(),
        "RECORD_DEPENDENCIES_MISSING"
    );
    partial.union(&fixture).unwrap();
    assert_eq!(
        partial.dependencies(&fixture).unwrap(),
        Dependencies {
            ready: [1, 0, 2]
                .map(|index| fixture.records[index].name.clone())
                .to_vec(),
            missing: vec![],
        }
    );
    let raw = partial.records_for_replay(&fixture).unwrap();
    assert_eq!(
        raw,
        [1, 0, 2].map(|index| {
            String::from_utf8(bytes(&fixture.records[index].content).unwrap()).unwrap()
        })
    );
    let mut wrong = fixture.clone();
    let mut changed: serde_json::Value =
        serde_json::from_slice(&bytes(&wrong.records[0].content).unwrap()).unwrap();
    changed["created_at"] = serde_json::Value::String("2026-11-07T05:00:00Z".into());
    let raw = serde_json::to_vec(&changed).unwrap();
    wrong.records[0] = Artifact {
        name: format!(
            "records/{}.{}.json",
            changed["id"].as_str().unwrap(),
            digest(&raw)
        ),
        content: STANDARD.encode(raw),
    };
    assert_eq!(
        wrong.dependencies(&fixture).unwrap_err(),
        "RECORD_PARENT_HASH_CONFLICT"
    );
}

#[test]
fn matching_filename_hash_cannot_bypass_canonical_encoding() {
    let fixture: State = serde_json::from_str(include_str!(
        "../../../tests/fixtures/native-record-journal/business.json"
    ))
    .unwrap();
    let original = &fixture.records[0];
    let mut raw = vec![b' '];
    raw.extend(bytes(&original.content).unwrap());
    let mut wrong = fixture.clone();
    wrong.records = vec![Artifact {
        name: format!(
            "{}.{}.json",
            original.name.split_once('.').unwrap().0,
            digest(&raw)
        ),
        content: STANDARD.encode(raw),
    }];
    assert_eq!(
        wrong.dependencies(&fixture).unwrap_err(),
        "NON_CANONICAL_JSON"
    );
}
