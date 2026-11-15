use crate::{
    record_journal::{bytes, digest, valid_record_name, Artifact},
    record_recovery::DatasetPin,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, Method, Url};
use serde::Deserialize;
use std::{sync::OnceLock, time::Duration};

const LIMIT: usize = 1024 * 1024;
const PROPFIND: &str =
    r#"<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#;
static CLIENT: OnceLock<Client> = OnceLock::new();

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebDavBinding {
    endpoint: String,
    directory: Vec<String>,
    username: String,
    password: String,
    pin: DatasetPin,
}

impl WebDavBinding {
    fn dataset_url(&self) -> Result<Url, String> {
        self.pin.validate()?;
        let mut url = Url::parse(&self.endpoint).map_err(|_| "RECORD_DAV_INVALID_TARGET")?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || self.username.is_empty()
            || self.username.contains(':')
            || self.password.is_empty()
            || self.directory.iter().any(|part| {
                part.is_empty()
                    || matches!(part.as_str(), "." | "..")
                    || part.contains(['/', '\\', '%'])
                    || part.chars().any(char::is_control)
            })
        {
            return Err("RECORD_DAV_INVALID_TARGET".into());
        }
        url.path_segments_mut()
            .map_err(|_| "RECORD_DAV_INVALID_TARGET")?
            .pop_if_empty()
            .extend(&self.directory)
            .push("record-sync")
            .push(&self.pin.dataset_id)
            .push("");
        Ok(url)
    }
}

#[tauri::command]
pub async fn request_record_webdav(
    binding: WebDavBinding,
    action: String,
    name: Option<String>,
    content: Option<String>,
) -> Result<Option<String>, String> {
    let dataset = binding.dataset_url()?;
    execute(dav_client()?, &binding, dataset, &action, name, content).await
}

fn dav_client() -> Result<&'static Client, String> {
    Ok(if let Some(client) = CLIENT.get() {
        client
    } else {
        let candidate = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "RECORD_DAV_CLIENT_FAILED")?;
        CLIENT.get_or_init(|| candidate)
    })
}

#[tauri::command]
pub async fn initialize_planning_webdav(binding: WebDavBinding, descriptor: String, baseline: String) -> Result<(), String> {
    let dataset = binding.dataset_url()?;
    let descriptor = bytes(&descriptor)?;
    let baseline = bytes(&baseline)?;
    let fixed = &[
        ("baseline", binding.pin.baseline_sha256.as_str(), baseline.as_slice()),
        ("dataset", binding.pin.descriptor_sha256.as_str(), descriptor.as_slice()),
    ];
    if fixed.iter().any(|(_, hash, raw)| raw.len() > LIMIT || digest(raw) != *hash) {
        return Err("RECORD_DAV_TARGET_MISMATCH".into());
    }
    validate_planning_fixed(&binding.pin, &descriptor, &baseline)?;
    initialize(dav_client()?, &binding, dataset, fixed).await
}

fn validate_planning_fixed(pin: &DatasetPin, descriptor: &[u8], baseline: &[u8]) -> Result<(), String> {
    let expected = |value: serde_json::Value| record_sync_codec_lab::canonicalize(&value.to_string())
        .map_err(str::to_owned).map(String::into_bytes);
    let at = "1970-01-01T00:00:00Z";
    let fixed_descriptor = expected(serde_json::json!({
        "protocol": pin.protocol, "dataset_id": pin.dataset_id, "baseline_sha256": pin.baseline_sha256,
        "data_schema_version": 1, "operation_set": "planning/1", "created_at": at
    }))?;
    let fixed_baseline = expected(serde_json::json!({
        "protocol": pin.protocol, "dataset_id": pin.dataset_id,
        "data": { "version": 1, "last_updated": at, "todos": [] }
    }))?;
    if fixed_descriptor != descriptor || fixed_baseline != baseline {
        return Err("RECORD_DAV_TARGET_MISMATCH".into());
    }
    Ok(())
}

async fn initialize(
    client: &Client, binding: &WebDavBinding, dataset: Url, fixed: &[(&str, &str, &[u8])],
) -> Result<(), String> {
    let request = |method, url| authenticated(client, binding, method, url);
    let join = |part: &str| dataset.join(part).map_err(|_| "RECORD_DAV_INVALID_TARGET".to_string());
    let descriptor = join(&format!("dataset.{}.json", binding.pin.descriptor_sha256))?;
    let response = request(Method::GET, descriptor).send().await.map_err(|_| "RECORD_DAV_NETWORK")?;
    if response.status() == 200 {
        if digest(&bounded(response).await?) != binding.pin.descriptor_sha256 {
            return Err("RECORD_DAV_TARGET_MISMATCH".into());
        }
    } else if response.status() == 404 {
        let mkcol = Method::from_bytes(b"MKCOL").unwrap();
        for url in [join("../")?, dataset.clone(), join("records/")?] {
            let status = request(mkcol.clone(), url).send().await.map_err(|_| "RECORD_DAV_NETWORK")?.status().as_u16();
            if !matches!(status, 201 | 405) { return Err(format!("RECORD_DAV_HTTP_{status}")); }
        }
    } else {
        return Err(format!("RECORD_DAV_HTTP_{}", response.status().as_u16()));
    }
    for (kind, hash, raw) in fixed {
        let url = join(&format!("{kind}.{hash}.json"))?;
        let response = request(Method::GET, url.clone()).send().await.map_err(|_| "RECORD_DAV_NETWORK")?;
        if response.status() == 200 {
            if bounded(response).await? != *raw { return Err("RECORD_DAV_TARGET_MISMATCH".into()); }
            continue;
        }
        if response.status() != 404 { return Err(format!("RECORD_DAV_HTTP_{}", response.status().as_u16())); }
        let status = request(Method::PUT, url.clone()).header("If-None-Match", "*")
            .header("Content-Type", "application/json").body(raw.to_vec()).send().await
            .map_err(|_| "RECORD_DAV_NETWORK")?.status().as_u16();
        if !matches!(status, 201 | 204 | 412) { return Err(format!("RECORD_DAV_HTTP_{status}")); }
        let response = request(Method::GET, url).send().await.map_err(|_| "RECORD_DAV_NETWORK")?;
        if response.status() == 404 { return Err("RECORD_DAV_NOT_VISIBLE".into()); }
        if response.status() != 200 { return Err(format!("RECORD_DAV_HTTP_{}", response.status().as_u16())); }
        if bounded(response).await? != *raw { return Err("RECORD_DAV_TARGET_MISMATCH".into()); }
    }
    Ok(())
}

fn authenticated(client: &Client, binding: &WebDavBinding, method: Method, url: Url) -> reqwest::RequestBuilder {
    client.request(method, url).basic_auth(&binding.username, Some(&binding.password)).header("Cache-Control", "no-cache")
}

async fn execute(
    client: &Client,
    binding: &WebDavBinding,
    dataset: Url,
    action: &str,
    name: Option<String>,
    content: Option<String>,
) -> Result<Option<String>, String> {
    let request = |method, url| authenticated(client, binding, method, url);
    let (method, relative, raw) = match (action, name, content) {
        ("list", None, None) => (
            Method::from_bytes(b"PROPFIND").unwrap(),
            "records/".into(),
            None,
        ),
        ("read", Some(name), None) if valid_record_name(&name) => (Method::GET, name, None),
        ("write" | "write_planning", Some(name), Some(content)) if valid_record_name(&name) => {
            let raw = bytes(&content)?;
            if action == "write_planning" {
                let record: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "RECORD_DAV_INVALID_RECORD")?;
                let operations = record["operations"].as_array().ok_or("RECORD_DAV_INVALID_RECORD")?;
                if operations.len() != 1 || !matches!(operations[0]["type"].as_str(),
                    Some("planning.version.save" | "planning.version.delete" | "planning.selection.resolve" | "planning.rating.put")) {
                    return Err("RECORD_DAV_INVALID_RECORD".into());
                }
            }
            let mut journal = binding.pin.empty_journal();
            journal.records.push(Artifact {
                name: name.clone(),
                content,
            });
            journal
                .dependencies(&journal)
                .map_err(|_| "RECORD_DAV_INVALID_RECORD")?;
            (Method::PUT, name, Some(raw))
        }
        _ => return Err("RECORD_DAV_INVALID_REQUEST".into()),
    };
    for (kind, hash) in [
        ("dataset", &binding.pin.descriptor_sha256),
        ("baseline", &binding.pin.baseline_sha256),
    ] {
        let response = request(
            Method::GET,
            dataset
                .join(&format!("{kind}.{hash}.json"))
                .map_err(|_| "RECORD_DAV_INVALID_TARGET")?,
        )
        .send()
        .await
        .map_err(|_| "RECORD_DAV_NETWORK")?;
        if response.status() != 200 || digest(&bounded(response).await?) != *hash {
            return Err("RECORD_DAV_TARGET_MISMATCH".into());
        }
    }
    let url = dataset
        .join(&relative)
        .map_err(|_| "RECORD_DAV_INVALID_TARGET")?;
    let mut builder = request(method, url);
    if action == "list" {
        builder = builder
            .header("Depth", "1")
            .header("Content-Type", "application/xml")
            .body(PROPFIND);
    } else if let Some(raw) = raw {
        builder = builder
            .header("If-None-Match", "*")
            .header("Content-Type", "application/json")
            .body(raw);
    }
    let response = builder.send().await.map_err(|_| "RECORD_DAV_NETWORK")?;
    let status = response.status().as_u16();
    match (action, status) {
        ("list", 207) => String::from_utf8(bounded(response).await?)
            .map(Some)
            .map_err(|_| "RECORD_DAV_INVALID_LIST".into()),
        ("read", 200) => Ok(Some(STANDARD.encode(bounded(response).await?))),
        ("read", 404) | ("write", 201 | 412) | ("write_planning", 201 | 204 | 412) => Ok(None),
        ("write", 204) => Err("RECORD_DAV_CREATE_UNVERIFIED".into()),
        _ => Err(format!("RECORD_DAV_HTTP_{status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn planning_initialization_creates_only_pinned_objects_and_reads_back_204() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native-record-journal/series-causal-replay.json"
        )).unwrap();
        let binding: WebDavBinding = serde_json::from_value(json!({
            "endpoint": "https://example.test/dav/", "directory": ["synthetic"], "username": "fake",
            "password": "fake", "pin": fixture["pin"]
        })).unwrap();
        let baseline_hash = binding.pin.baseline_sha256.clone();
        let descriptor_hash = binding.pin.descriptor_sha256.clone();
        let baseline_name = format!("baseline.{baseline_hash}.json");
        let descriptor_name = format!("dataset.{descriptor_hash}.json");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/isolated/record-sync/dataset/", listener.local_addr().unwrap())).unwrap();
        let server = thread::spawn(move || {
            let root = "/isolated/record-sync/dataset/";
            for (method, path, request, status, response) in [
                ("GET", format!("{root}{descriptor_name}"), "", 404, ""),
                ("MKCOL", "/isolated/record-sync/".into(), "", 405, ""),
                ("MKCOL", root.into(), "", 201, ""),
                ("MKCOL", format!("{root}records/"), "", 201, ""),
                ("GET", format!("{root}{baseline_name}"), "", 404, ""),
                ("PUT", format!("{root}{baseline_name}"), "baseline", 204, ""),
                ("GET", format!("{root}{baseline_name}"), "", 200, "baseline"),
                ("GET", format!("{root}{descriptor_name}"), "", 404, ""),
                ("PUT", format!("{root}{descriptor_name}"), "descriptor", 201, ""),
                ("GET", format!("{root}{descriptor_name}"), "", 200, "descriptor"),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut input = BufReader::new(&mut socket);
                let mut line = String::new();
                input.read_line(&mut line).unwrap();
                assert!(line.starts_with(&format!("{method} {path} ")), "{line}");
                let mut headers = String::new();
                loop {
                    line.clear();
                    assert_ne!(input.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" { break; }
                    headers.push_str(&line);
                }
                if method == "PUT" {
                    assert!(headers.to_ascii_lowercase().contains("if-none-match: *\r\n"));
                    let mut bytes = vec![0; request.len()];
                    input.read_exact(&mut bytes).unwrap();
                    assert_eq!(bytes, request.as_bytes());
                }
                write!(socket, "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{response}", response.len()).unwrap();
            }
        });
        tauri::async_runtime::block_on(async {
            let client = Client::builder().no_proxy().timeout(Duration::from_secs(4)).build().unwrap();
            initialize(&client, &binding, url, &[
                ("baseline", binding.pin.baseline_sha256.as_str(), b"baseline"),
                ("dataset", binding.pin.descriptor_sha256.as_str(), b"descriptor"),
            ]).await.unwrap();
        });
        server.join().unwrap();
    }

    #[test]
    fn webdav_revalidates_dataset_and_preserves_conditional_write_status() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native-record-journal/series-causal-replay.json"
        ))
        .unwrap();
        let pin = &fixture["pin"];
        let descriptor = bytes(fixture["descriptor"]["content"].as_str().unwrap()).unwrap();
        let baseline = json!({ "protocol": pin["protocol"], "dataset_id": pin["dataset_id"], "data": fixture["baseline"] });
        let baseline = record_sync_codec_lab::canonicalize(&baseline.to_string())
            .unwrap()
            .into_bytes();
        let item: Artifact =
            serde_json::from_value(fixture["cases"][0]["journal"]["records"][1].clone()).unwrap();
        let binding: WebDavBinding = serde_json::from_value(json!({
            "endpoint": "https://example.test/dav/", "directory": ["合成"], "username": "fake",
            "password": "fake", "pin": pin
        }))
        .unwrap();
        assert!(binding
            .dataset_url()
            .unwrap()
            .path()
            .starts_with("/dav/%E5%90%88%E6%88%90/record-sync/"));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/dataset/",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let expected_body = bytes(&item.content).unwrap();
        let expected_path = item.name.clone();
        let server = thread::spawn(move || {
            for (index, (status, body)) in [
                (200, descriptor.clone()),
                (200, baseline.clone()),
                (412, Vec::new()),
                (200, descriptor),
                (200, baseline),
                (204, Vec::new()),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut input = BufReader::new(&mut socket);
                let mut header = String::new();
                loop {
                    let mut line = String::new();
                    assert_ne!(input.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    header.push_str(&line);
                }
                if index % 3 == 2 {
                    assert!(header.starts_with(&format!("PUT /dataset/{expected_path} ")));
                    assert!(header.to_ascii_lowercase().contains("if-none-match: *\r\n"));
                    let mut raw = vec![0; expected_body.len()];
                    input.read_exact(&mut raw).unwrap();
                    assert_eq!(raw, expected_body);
                } else {
                    assert!(header.starts_with(if index % 3 == 0 {
                        "GET /dataset/dataset."
                    } else {
                        "GET /dataset/baseline."
                    }));
                }
                write!(
                    socket,
                    "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                )
                .unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        let result = tauri::async_runtime::block_on(async {
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(4))
                .build()
                .unwrap();
            let result = execute(
                &client,
                &binding,
                url.clone(),
                "write",
                Some(item.name.clone()),
                Some(item.content.clone()),
            )
            .await;
            assert_eq!(result.unwrap(), None);
            execute(
                &client,
                &binding,
                url,
                "write",
                Some(item.name),
                Some(item.content),
            )
            .await
        });
        assert_eq!(result.unwrap_err(), "RECORD_DAV_CREATE_UNVERIFIED");
        server.join().unwrap();
    }
}

async fn bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "RECORD_DAV_NETWORK")? {
        if raw.len() + chunk.len() > LIMIT {
            return Err("RECORD_DAV_SIZE_LIMIT".into());
        }
        raw.extend_from_slice(&chunk);
    }
    Ok(raw)
}
