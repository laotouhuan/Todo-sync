use super::{CollaborationSource, CollabReadResult, decrypt_share_code};
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::SystemTime;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct SharePayload {
    pub url: String,
    pub user: String,
    pub pass: String,
    pub path: String,
    #[serde(default)]
    pub exp: i64,
}

impl SharePayload {
    pub fn source(&self) -> CollaborationSource {
        CollaborationSource {
            webdav_url: self.url.clone(), webdav_username: self.user.clone(),
            webdav_password: self.pass.clone(), webdav_filepath: self.path.clone(),
            expire_at: if self.exp == 0 { None } else { Some(self.exp) },
            ..Default::default()
        }
    }

    fn validate(&self) -> Result<(), String> {
        let url = reqwest::Url::parse(&self.url).map_err(|_| "WebDAV 地址必须是有效的 HTTPS 地址")?;
        if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() ||
            url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err("WebDAV 地址必须是有效的 HTTPS 地址，且不包含凭据、查询或片段".into());
        }
        if self.url.trim() != self.url || self.user.trim() != self.user {
            return Err("地址或账号首尾含空白，请检查并保存连接设置".into());
        }
        if self.user.trim().is_empty() || self.user.contains(':') || self.pass.trim().is_empty() {
            return Err("WebDAV 账号或应用密码无效".into());
        }
        if self.path.trim().is_empty() || self.path.trim() != self.path || self.path.starts_with('/') ||
            self.path.ends_with('/') || self.path.contains('\\') || self.path.split('/').any(|s| s == "." || s == "..") {
            return Err("云端文件路径无效".into());
        }
        if self.exp < 0 { return Err("授权有效期无效".into()); }
        Ok(())
    }
}

pub(super) fn decode(code: String, key: String) -> Result<SharePayload, String> {
    let value = decrypt_share_code(code.trim().into(), key)
        .map_err(|_| "分享码或提取密钥不正确，请重新复制完整内容。")?;
    serde_json::from_value(value).map_err(|_| "分享码字段无效，请重新复制完整内容。".into())
}

pub(super) fn http_status(status: u16) -> Result<(), String> {
    match status {
        200..=299 => Ok(()),
        401 => Err("对方 WebDAV 认证失败（401）。请让对方确认个人同步成功，并重新生成分享码后导入。".into()),
        403 => Err("服务器拒绝访问（403），请对方检查访问权限。".into()),
        404 => Err("对方待办文件不存在（404），请确认路径并完成一次同步。".into()),
        300..=399 => Err("服务器返回重定向，请确认 WebDAV 目标地址后重试。".into()),
        s => Err(format!("WebDAV 请求失败（{s}），请稍后重试。")),
    }
}

fn expiry(exp: Option<i64>, date: &str) -> Result<(), String> {
    if let Some(exp) = exp {
        let time = httpdate::parse_http_date(date).map_err(|_| "无法验证授权有效期，请稍后重试。")?;
        let seconds = time.duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| "无法验证授权有效期，请稍后重试。")?.as_secs() as i64;
        if seconds > exp { return Err("EXPIRED".into()); }
    }
    Ok(())
}

fn valid_data(body: &str) -> Result<(), String> {
    let invalid = "对方待办文件格式无效，请检查同步文件";
    let data: serde_json::Value = serde_json::from_str(body).map_err(|_| invalid)?;
    if !data["version"].is_i64() || !data["last_updated"].is_string() { return Err(invalid.into()); }
    let todos = data["todos"].as_array().ok_or(invalid)?;
    for todo in todos {
        if !todo["id"].is_string() || !todo["content"].is_string() || !todo["completed"].is_boolean() ||
            !todo["created_at"].is_string() { return Err(invalid.into()); }
    }
    Ok(())
}

pub(super) async fn read(client: &reqwest::Client, source: &CollaborationSource) -> Result<CollabReadResult, String> {
    let response = client.get(super::build_collab_url(source))
        .basic_auth(&source.webdav_username, Some(&source.webdav_password))
        .send().await.map_err(|_| "无法连接对方服务器，请检查地址和网络后重试。")?;
    http_status(response.status().as_u16())?;
    let server_time = response.headers().get("date").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    expiry(source.expire_at, &server_time)?;
    let data = response.text().await.map_err(|_| "无法读取对方待办文件，请稍后重试。")?;
    valid_data(&data)?;
    Ok(CollabReadResult { data, server_time })
}

pub(super) async fn generate(client: &reqwest::Client, payload: SharePayload,
    is_current: impl FnOnce() -> bool) -> Result<(String, String), String> {
    let source = payload.source();
    generate_with_read(payload, is_current, read(client, &source)).await
}

async fn generate_with_read(payload: SharePayload, is_current: impl FnOnce() -> bool,
    download: impl std::future::Future<Output = Result<CollabReadResult, String>>) -> Result<(String, String), String> {
    payload.validate()?;
    download.await?;
    if !is_current() { return Err("连接配置已修改，请保存后重新生成".into()); }
    encrypt(&payload)
}

pub(super) async fn import<T>(client: &reqwest::Client, payload: SharePayload,
    commit: impl FnOnce(SharePayload) -> Result<T, String>) -> Result<T, String> {
    let source = payload.source();
    import_with_read(payload, commit, read(client, &source)).await
}

async fn import_with_read<T>(payload: SharePayload, commit: impl FnOnce(SharePayload) -> Result<T, String>,
    download: impl std::future::Future<Output = Result<CollabReadResult, String>>) -> Result<T, String> {
    payload.validate()?;
    download.await?;
    commit(payload)
}

fn encrypt(payload: &SharePayload) -> Result<(String, String), String> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    let key: String = (0..12).map(|_| alphabet[rng.gen_range(0..alphabet.len())] as char).collect();
    let mut iv = [0u8; 12];
    rng.fill(&mut iv);
    encrypt_with_material(payload, key, iv)
}

fn encrypt_with_material(payload: &SharePayload, key: String, iv: [u8; 12]) -> Result<(String, String), String> {
    let key_bytes = Sha256::digest(key.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|_| "加密失败")?;
    let plaintext = serde_json::to_vec(payload).map_err(|_| "分享码字段无效")?;
    let ciphertext = cipher.encrypt(Nonce::from_slice(&iv), plaintext.as_slice()).map_err(|_| "加密失败")?;
    let mut packed = iv.to_vec();
    packed.extend_from_slice(&ciphertext);
    Ok((format!("tdsync://{}", base64::engine::general_purpose::STANDARD.encode(packed)), key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread};

    fn payload() -> SharePayload {
        SharePayload { url: "https://example.test/dav/".into(), user: "fake".into(),
            pass: " fake-password ".into(), path: "清单/todo_data.json".into(), exp: 0 }
    }

    // 测试仅把网络目标改为本机 HTTP，凭据和生产请求/响应处理保持不变。
    fn server(status: u16, body: &str, date: Option<&str>, count: usize)
        -> (CollaborationSource, reqwest::Client, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut source = payload().source();
        source.webdav_url = format!("http://{}/dav/", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{}{}\r\n{body}",
            body.len(), date.map(|s| format!("Date: {s}\r\n")).unwrap_or_default(),
            if (300..400).contains(&status) { "Location: https://other.test/leak\r\n" } else { "" });
        let worker = thread::spawn(move || {
            let mut requests = vec![];
            for _ in 0..count {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
                let mut bytes = vec![];
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if socket.read(&mut byte).unwrap() == 0 { break; }
                    bytes.push(byte[0]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                socket.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(3)).build().unwrap();
        (source, client, worker)
    }

    fn run(future: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future);
    }

    #[test]
    fn http_failure_never_generates_or_commits_even_when_expiry_date_missing() {
        run(async {
            for status in [401, 403, 404, 302] {
                let (mut source, client, worker) = server(status, "denied", None, 2);
                source.expire_at = Some(1);
                let result = generate_with_read(payload(), || true, read(&client, &source)).await;
                assert!(result.is_err());
                if status == 401 { assert!(result.err().unwrap().contains("401")); }
                let mut password = "existing".to_string();
                let imported = import_with_read(payload(), |p| { password = p.pass; Ok(()) }, read(&client, &source)).await;
                assert!(imported.is_err());
                assert_eq!(password, "existing");
                assert_eq!(worker.join().unwrap().len(), 2);
            }
        });
    }

    #[test]
    fn valid_response_generates_exact_snapshot_and_preserves_password_whitespace() {
        run(async {
            let (source, client, worker) = server(200, r#"{"version":1,"last_updated":"2026-10-06T00:00:00Z","todos":[]}"#, None, 2);
            let (code, key) = generate_with_read(payload(), || true, read(&client, &source)).await.unwrap();
            let decoded = decode(code, key).unwrap();
            assert!(decoded == payload());
            let imported = import_with_read(payload(), |p| Ok(p.pass), read(&client, &source)).await.unwrap();
            assert_eq!(imported, payload().pass);
            let auth = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", payload().user, payload().pass));
            assert!(worker.join().unwrap().iter().all(|request| request.contains(&auth) && request.starts_with("GET /dav/")));
        });
    }

    #[test]
    fn invalid_data_expiry_and_changed_configuration_are_rejected() {
        run(async {
            for (body, exp, date) in [("broken", None, None), ("{}", None, None),
                (r#"{"todos":[{}]}"#, None, None), (r#"{"todos":[]}"#, Some(1), None),
                (r#"{"todos":[]}"#, Some(1), Some("invalid")),
                (r#"{"todos":[]}"#, Some(1), Some("Tue, 15 Nov 1994 08:12:31 GMT"))] {
                let (mut source, client, worker) = server(200, body, date, 1);
                source.expire_at = exp;
                assert!(import_with_read(payload(), |_| -> Result<(), String> { panic!("must not commit") }, read(&client, &source)).await.is_err());
                worker.join().unwrap();
            }
            let (source, client, worker) = server(200, r#"{"version":1,"last_updated":"2026-10-06T00:00:00Z","todos":[]}"#, None, 1);
            assert!(generate_with_read(payload(), || false, read(&client, &source)).await.is_err());
            worker.join().unwrap();
        });
    }

    #[test]
    fn malformed_payload_never_reaches_http_and_wrong_key_fails_decryption() {
        run(async {
            let mut invalid = payload();
            invalid.user = " ".into();
            assert!(import_with_read(invalid, |_| Ok(()), async { panic!("must not request") }).await.is_err());
            let (code, _) = encrypt(&payload()).unwrap();
            assert!(decode(code, "wrong-key".into()).is_err());
            assert!(decode("tdsync://broken".into(), "key".into()).is_err());
        });
    }

    #[test]
    fn finite_expiry_uses_server_time_and_permanent_expiry_needs_no_date() {
        assert!(expiry(None, "").is_ok());
        assert!(expiry(Some(784887151), "Tue, 15 Nov 1994 08:12:31 GMT").is_ok());
        assert_eq!(expiry(Some(784887150), "Tue, 15 Nov 1994 08:12:31 GMT"), Err("EXPIRED".into()));
    }

    #[test]
    fn android_and_windows_use_identical_fixed_vector() {
        let expected = "tdsync://AAECAwQFBgcICQoLxSI6rslQ52PCxcr4pKP+HmFNFGGj850ZGLoMUfakTjFHV71GJL1W//6Mki8L21FBGaxixdWRDoZzBdXCPhvPmo9K4l0GPPv+6v/eCqWOr+GGSr+yuGWCefcQ6h8bjv4U8Y3H+ystspXaRgdDGHKjxcOAzdiAO427EjGROwBxkxfW";
        let key = "AbCdEf012345".to_string();
        let result = encrypt_with_material(&payload(), key.clone(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).unwrap();
        assert_eq!(result.0, expected);
        assert!(decode(expected.into(), key).unwrap() == payload());
    }
}
