use record_sync_codec_lab::{
    business, canonicalize, decode_canonical, hex_bytes, number_from_hex, sha256, validate_join,
    verify_record,
};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn required<'a>(request: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    request
        .get(key)
        .and_then(Value::as_str)
        .ok_or("INVALID_REQUEST")
}

fn reply(request: &Value) -> Result<Value, &'static str> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let canonical = match required(request, "kind")? {
        "canonicalize" => canonicalize(required(request, "input")?)?,
        "decode" => decode_canonical(&hex_bytes(required(request, "hex")?)?)?,
        "number" => number_from_hex(required(request, "hex")?)?,
        "join" => {
            validate_join(
                request.get("pin").ok_or("INVALID_REQUEST")?,
                &hex_bytes(required(request, "descriptor_hex")?)?,
                &hex_bytes(required(request, "baseline_hex")?)?,
            )?;
            return Ok(json!({"id":id,"ok":true}));
        }
        "record" => {
            verify_record(
                request.get("pin").ok_or("INVALID_REQUEST")?,
                required(request, "name")?,
                &hex_bytes(required(request, "hex")?)?,
            )?;
            return Ok(json!({"id":id,"ok":true}));
        }
        "business" => {
            let winners = business(
                required(request, "domain")?,
                request
                    .get("records")
                    .and_then(Value::as_array)
                    .ok_or("INVALID_REQUEST")?,
            )?;
            return Ok(json!({"id":id,"ok":true,"winners":winners}));
        }
        _ => return Err("UNKNOWN_REQUEST_KIND"),
    };
    Ok(json!({"id":id,"ok":true,"sha256":sha256(canonical.as_bytes()),"canonical":canonical}))
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().split(b'\n') {
        let output = match line {
            Ok(line) => match serde_json::from_slice::<Value>(&line) {
                Ok(request) => reply(&request).unwrap_or_else(|code| json!({"id":request.get("id").cloned().unwrap_or(Value::Null),"ok":false,"error_code":code})),
                Err(_) => json!({"id":null,"ok":false,"error_code":"INVALID_REQUEST_JSON"}),
            },
            Err(_) => json!({"id":null,"ok":false,"error_code":"STDIN_ERROR"}),
        };
        // 一行错误不会退出；标准输出仅包含逐行 JSON，便于外部共同样本驱动。
        if serde_json::to_writer(&mut stdout, &output).is_err()
            || writeln!(&mut stdout).is_err()
            || stdout.flush().is_err()
        {
            break;
        }
    }
}
