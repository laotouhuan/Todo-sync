use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

// 隔离的跨语言编码实验，不被应用导入，也不解释正式业务操作。
const MAX_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: usize = 128;
const PROTOCOL: &str = "todo-record-sync/1";
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Debug)]
enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Self::Object(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn string(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }
    fn array(&self) -> Option<&[Value]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }
    fn number(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }
    fn exact(&self, keys: &[&str]) -> bool {
        matches!(self, Self::Object(items) if items.len() == keys.len() && keys.iter().all(|key| self.get(key).is_some()))
    }
    fn text(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::string)
    }
}

fn valid_character(c: char) -> bool {
    let n = c as u32;
    !(0xfdd0..=0xfdef).contains(&n) && n & 0xffff < 0xfffe
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl<'a> Parser<'a> {
    fn whitespace(&mut self) {
        while self
            .text
            .as_bytes()
            .get(self.at)
            .is_some_and(|b| matches!(*b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.at += 1;
        }
    }
    fn take(&mut self, expected: u8) -> Result<()> {
        if self.text.as_bytes().get(self.at) != Some(&expected) {
            return Err("INVALID_JSON");
        }
        self.at += 1;
        Ok(())
    }
    fn hex4(&mut self) -> Result<u32> {
        let bytes = self
            .text
            .as_bytes()
            .get(self.at..self.at + 4)
            .ok_or("INVALID_JSON")?;
        let mut number = 0;
        for b in bytes {
            let digit = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => return Err("INVALID_JSON"),
            };
            number = number * 16 + digit as u32;
        }
        self.at += 4;
        Ok(number)
    }
    fn string(&mut self) -> Result<String> {
        self.take(b'"')?;
        let mut output = String::new();
        loop {
            let b = *self.text.as_bytes().get(self.at).ok_or("INVALID_JSON")?;
            if b == b'"' {
                self.at += 1;
                return Ok(output);
            }
            let c = if b == b'\\' {
                self.at += 1;
                let escaped = *self.text.as_bytes().get(self.at).ok_or("INVALID_JSON")?;
                self.at += 1;
                match escaped {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let high = self.hex4()?;
                        let scalar = if (0xd800..=0xdbff).contains(&high) {
                            self.take(b'\\')?;
                            self.take(b'u')?;
                            let low = self.hex4()?;
                            if !(0xdc00..=0xdfff).contains(&low) {
                                return Err("INVALID_UNICODE");
                            }
                            0x10000 + (high - 0xd800) * 0x400 + low - 0xdc00
                        } else {
                            high
                        };
                        char::from_u32(scalar).ok_or("INVALID_UNICODE")?
                    }
                    _ => return Err("INVALID_JSON"),
                }
            } else {
                if b < 0x20 {
                    return Err("INVALID_JSON");
                }
                let c = self.text[self.at..].chars().next().ok_or("INVALID_JSON")?;
                self.at += c.len_utf8();
                c
            };
            if !valid_character(c) {
                return Err("INVALID_UNICODE");
            }
            output.push(c);
        }
    }
    fn digit(&self) -> bool {
        self.text
            .as_bytes()
            .get(self.at)
            .is_some_and(u8::is_ascii_digit)
    }
    fn number(&mut self) -> Result<Value> {
        let start = self.at;
        if self.text.as_bytes().get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        match self.text.as_bytes().get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.at += 1;
                while self.digit() {
                    self.at += 1;
                }
            }
            _ => return Err("INVALID_JSON_NUMBER"),
        }
        if self.text.as_bytes().get(self.at) == Some(&b'.') {
            self.at += 1;
            if !self.digit() {
                return Err("INVALID_JSON_NUMBER");
            }
            while self.digit() {
                self.at += 1;
            }
        }
        if self
            .text
            .as_bytes()
            .get(self.at)
            .is_some_and(|b| matches!(*b, b'e' | b'E'))
        {
            self.at += 1;
            if self
                .text
                .as_bytes()
                .get(self.at)
                .is_some_and(|b| matches!(*b, b'+' | b'-'))
            {
                self.at += 1;
            }
            if !self.digit() {
                return Err("INVALID_JSON_NUMBER");
            }
            while self.digit() {
                self.at += 1;
            }
        }
        let value: f64 = self.text[start..self.at]
            .parse()
            .map_err(|_| "INVALID_JSON_NUMBER")?;
        if !value.is_finite() {
            return Err("INVALID_JSON_NUMBER");
        }
        Ok(Value::Number(value))
    }
    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > MAX_DEPTH {
            return Err("JSON_DEPTH_LIMIT");
        }
        self.whitespace();
        let b = *self.text.as_bytes().get(self.at).ok_or("INVALID_JSON")?;
        match b {
            b'"' => self.string().map(Value::String),
            b'{' => {
                self.at += 1;
                self.whitespace();
                let mut items = Vec::new();
                let mut keys = HashSet::new();
                if self.text.as_bytes().get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Value::Object(items));
                }
                loop {
                    let key = self.string()?;
                    // 在构造普通映射之前按解码后的键检查重复，包括转义别名。
                    if !keys.insert(key.clone()) {
                        return Err("DUPLICATE_JSON_KEY");
                    }
                    self.whitespace();
                    self.take(b':')?;
                    items.push((key, self.value(depth + 1)?));
                    self.whitespace();
                    if self.text.as_bytes().get(self.at) == Some(&b'}') {
                        self.at += 1;
                        return Ok(Value::Object(items));
                    }
                    self.take(b',')?;
                    self.whitespace();
                }
            }
            b'[' => {
                self.at += 1;
                self.whitespace();
                let mut items = Vec::new();
                if self.text.as_bytes().get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Value::Array(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.whitespace();
                    if self.text.as_bytes().get(self.at) == Some(&b']') {
                        self.at += 1;
                        return Ok(Value::Array(items));
                    }
                    self.take(b',')?;
                }
            }
            _ => {
                for (literal, value) in [
                    ("null", Value::Null),
                    ("true", Value::Bool(true)),
                    ("false", Value::Bool(false)),
                ] {
                    if self.text[self.at..].starts_with(literal) {
                        self.at += literal.len();
                        return Ok(value);
                    }
                }
                self.number()
            }
        }
    }
}

fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_BYTES {
        return Err("JSON_SIZE_LIMIT");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "INVALID_UTF8")?;
    let mut parser = Parser { text, at: 0 };
    let result = parser.value(0)?;
    parser.whitespace();
    if parser.at != text.len() {
        return Err("INVALID_JSON");
    }
    Ok(result)
}

fn quoted(text: &str, output: &mut String) {
    output.push('"');
    for c in text.chars() {
        match c {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{8}' => output.push_str("\\b"),
            '\u{c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c < '\u{20}' => {
                use std::fmt::Write;
                write!(output, "\\u{:04x}", c as u32).unwrap();
            }
            _ => output.push(c),
        }
    }
    output.push('"');
}

fn number_text(number: f64) -> Result<String> {
    if !number.is_finite() {
        return Err("INVALID_JSON_NUMBER");
    }
    if number == 0.0 {
        return Ok("0".into());
    }
    // ryu-js 独立实现 ECMAScript binary64 输出，不借用 Node 或期望样本格式化。
    Ok(ryu_js::Buffer::new().format_finite(number).to_owned())
}

fn render(value: &Value, output: &mut String) -> Result<()> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&number_text(*value)?),
        Value::String(value) => quoted(value, output),
        Value::Array(items) => {
            output.push('[');
            for (index, child) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                render(child, output)?;
            }
            output.push(']');
        }
        Value::Object(items) => {
            let mut sorted: Vec<_> = items.iter().collect();
            sorted.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            output.push('{');
            for (index, (key, child)) in sorted.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                quoted(key, output);
                output.push(':');
                render(child, output)?;
            }
            output.push('}');
        }
    }
    if output.len() > MAX_BYTES {
        return Err("JSON_SIZE_LIMIT");
    }
    Ok(())
}

fn canonical(value: &Value) -> Result<String> {
    let mut output = String::new();
    render(value, &mut output)?;
    Ok(output)
}

pub fn canonicalize(input: &str) -> Result<String> {
    canonical(&parse(input.as_bytes())?)
}

fn decode(bytes: &[u8]) -> Result<Value> {
    let value = parse(bytes)?;
    if canonical(&value)?.as_bytes() != bytes {
        return Err("NON_CANONICAL_JSON");
    }
    Ok(value)
}

pub fn decode_canonical(bytes: &[u8]) -> Result<String> {
    canonical(&decode(bytes)?)
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn hex_bytes(hex: &str) -> Result<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return Err("INVALID_HEX");
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16).ok_or("INVALID_HEX")?;
            let low = (pair[1] as char).to_digit(16).ok_or("INVALID_HEX")?;
            Ok((high * 16 + low) as u8)
        })
        .collect()
}

pub fn number_from_hex(hex: &str) -> Result<String> {
    if hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("INVALID_NUMBER_BITS");
    }
    let bits = u64::from_str_radix(hex, 16).map_err(|_| "INVALID_NUMBER_BITS")?;
    number_text(f64::from_bits(bits))
}

fn uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, b)| {
            if [8, 13, 18, 23].contains(&index) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn digits(bytes: &[u8]) -> Option<i64> {
    if !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        bytes
            .iter()
            .fold(0, |value, digit| value * 10 + (digit - b'0') as i64),
    )
}

fn leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

// 与实验封装一致：拒绝越界日历、24时及闰秒，比较业务时钟时截取毫秒精度。
pub fn time_millis(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year = digits(&b[0..4])?;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])?;
    let minute = digits(&b[14..16])?;
    let second = digits(&b[17..19])?;
    let month_days = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month)
        || day < 1
        || day > month_days[(month - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut at = 19;
    let mut millis = 0;
    if b.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return None;
        }
        for index in 0..3 {
            millis = millis * 10
                + b.get(start + index)
                    .filter(|_| start + index < at)
                    .map_or(0, |v| (v - b'0') as i64);
        }
    }
    let offset = if b.get(at) == Some(&b'Z') && b.len() == at + 1 {
        0
    } else {
        if b.len() != at + 6 || !matches!(b[at], b'+' | b'-') || b[at + 3] != b':' {
            return None;
        }
        let h = digits(&b[at + 1..at + 3])?;
        let m = digits(&b[at + 4..at + 6])?;
        if h > 23 || m > 59 {
            return None;
        }
        (h * 60 + m) * if b[at] == b'+' { 1 } else { -1 }
    };
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = adjusted_year.div_euclid(400);
    let yoe = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * shifted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((((days * 24 + hour) * 60 + minute - offset) * 60 + second) * 1000 + millis)
}

fn pin(value: &serde_json::Value) -> Result<Value> {
    let parsed = parse(
        serde_json::to_string(value)
            .map_err(|_| "INVALID_PIN")?
            .as_bytes(),
    )?;
    if !parsed.exact(&[
        "protocol",
        "dataset_id",
        "descriptor_sha256",
        "baseline_sha256",
        "namespace",
    ]) || parsed.text("protocol") != Some(PROTOCOL)
    {
        return Err("INVALID_PIN");
    }
    let dataset = parsed
        .text("dataset_id")
        .filter(|s| uuid(s))
        .ok_or("INVALID_PIN")?;
    if !parsed.text("descriptor_sha256").is_some_and(digest)
        || !parsed.text("baseline_sha256").is_some_and(digest)
        || parsed.text("namespace") != Some(format!("record-sync/{dataset}/").as_str())
    {
        return Err("INVALID_PIN");
    }
    Ok(parsed)
}

pub fn validate_join(
    pin_value: &serde_json::Value,
    descriptor_bytes: &[u8],
    baseline_bytes: &[u8],
) -> Result<()> {
    let pin = pin(pin_value)?;
    if pin.text("descriptor_sha256") != Some(sha256(descriptor_bytes).as_str())
        || pin.text("baseline_sha256") != Some(sha256(baseline_bytes).as_str())
    {
        return Err("DATASET_HASH_MISMATCH");
    }
    let descriptor = decode(descriptor_bytes)?;
    let baseline = decode(baseline_bytes)?;
    if !descriptor.exact(&[
        "protocol",
        "dataset_id",
        "baseline_sha256",
        "data_schema_version",
        "operation_set",
        "created_at",
    ]) || descriptor.text("protocol") != Some(PROTOCOL)
        || descriptor.text("dataset_id") != pin.text("dataset_id")
        || descriptor.text("baseline_sha256") != pin.text("baseline_sha256")
        || descriptor
            .get("data_schema_version")
            .and_then(Value::number)
            != Some(1.0)
        || descriptor.text("operation_set") != Some("lab-note/1")
        || !descriptor
            .text("created_at")
            .is_some_and(|t| time_millis(t).is_some())
        || !baseline.exact(&["protocol", "dataset_id", "data"])
        || baseline.text("protocol") != Some(PROTOCOL)
        || baseline.text("dataset_id") != pin.text("dataset_id")
        || !matches!(baseline.get("data"), Some(Value::Object(_)))
    {
        return Err("INVALID_DATASET_BINDING");
    }
    Ok(())
}

pub fn verify_record(pin_value: &serde_json::Value, name: &str, bytes: &[u8]) -> Result<()> {
    let pin = pin(pin_value)?;
    let filename = name
        .strip_prefix("records/")
        .and_then(|s| s.strip_suffix(".json"))
        .ok_or("INVALID_RECORD_FILENAME")?;
    let (id, hash) = filename.split_once('.').ok_or("INVALID_RECORD_FILENAME")?;
    if !uuid(id) || !digest(hash) || hash != sha256(bytes) {
        return Err("INVALID_RECORD_FILENAME");
    }
    let record = decode(bytes)?;
    if !record.exact(&[
        "protocol",
        "dataset_id",
        "descriptor_sha256",
        "id",
        "actor_id",
        "parents",
        "lamport",
        "created_at",
        "operations",
    ]) || record.text("protocol") != Some(PROTOCOL)
        || record.text("dataset_id") != pin.text("dataset_id")
        || record.text("descriptor_sha256") != pin.text("descriptor_sha256")
        || record.text("id") != Some(id)
        || !record.text("actor_id").is_some_and(uuid)
        || !record
            .text("created_at")
            .is_some_and(|t| time_millis(t).is_some())
        || !record
            .get("lamport")
            .and_then(Value::number)
            .is_some_and(|n| (1.0..=9007199254740991.0).contains(&n) && n.fract() == 0.0)
    {
        return Err("INVALID_RECORD_ENVELOPE");
    }
    let parents = record
        .get("parents")
        .and_then(Value::array)
        .ok_or("INVALID_PARENTS")?;
    let mut ids = HashSet::new();
    let mut previous: Option<(&str, &str)> = None;
    for parent in parents {
        if !parent.exact(&["id", "sha256"]) {
            return Err("INVALID_PARENT");
        }
        let parent_id = parent
            .text("id")
            .filter(|s| uuid(s))
            .ok_or("INVALID_PARENT")?;
        let hash = parent
            .text("sha256")
            .filter(|s| digest(s))
            .ok_or("INVALID_PARENT")?;
        if parent_id == id
            || !ids.insert(parent_id)
            || previous.is_some_and(|old| old >= (parent_id, hash))
        {
            return Err("INVALID_PARENT");
        }
        previous = Some((parent_id, hash));
    }
    let operations = record
        .get("operations")
        .and_then(Value::array)
        .filter(|v| !v.is_empty())
        .ok_or("INVALID_OPERATIONS")?;
    for operation in operations {
        if !operation.exact(&["type", "key", "value"])
            || operation.text("type") != Some("lab.note.set")
            || !operation.text("key").is_some_and(|s| !s.is_empty())
            || operation.text("value").is_none()
        {
            return Err("INVALID_OPERATIONS");
        }
    }
    Ok(())
}

fn canonical_learning(value: &Value) -> Result<String> {
    Ok(match value {
        Value::Null => "n".into(),
        Value::Bool(value) => if *value { "b1" } else { "b0" }.into(),
        Value::String(value) => format!("s{}:{value}", value.encode_utf16().count()),
        Value::Number(value) => format!("d{}", number_text(*value)?),
        Value::Array(values) => {
            let mut s = String::from("a");
            for value in values {
                s.push_str(&canonical_learning(value)?);
            }
            s.push('e');
            s
        }
        Value::Object(values) => {
            let mut values: Vec<_> = values.iter().collect();
            values.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            let mut s = String::from("o");
            for (key, value) in values {
                s.push_str(&canonical_learning(&Value::String(key.clone()))?);
                s.push_str(&canonical_learning(value)?);
            }
            s.push('e');
            s
        }
    })
}

fn js_whitespace(value: char) -> bool {
    matches!(value as u32, 9..=13 | 32 | 160 | 5760 | 8192..=8202 | 8232 | 8233 | 8239 | 8287 | 12288 | 65279)
}

fn optional_time(value: &serde_json::Value) -> bool {
    value.is_null()
        || value
            .as_str()
            .is_some_and(|text| time_millis(text).is_some())
}

fn normalize_todo(original: &serde_json::Value) -> Result<serde_json::Value> {
    // 统一到实验的 binary64 JSON 值，保留所有未知键、嵌套结构和数组次序。
    let encoded = serde_json::to_string(original).map_err(|_| "INVALID_TODO_JSON")?;
    let normalized_json = canonical(&parse(encoded.as_bytes())?)?;
    let mut result: serde_json::Value =
        serde_json::from_str(&normalized_json).map_err(|_| "INVALID_TODO_JSON")?;
    let todo = result.as_object_mut().ok_or("INVALID_NORMAL_TODO")?;
    let id = todo
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or("INVALID_TODO_ID")?;
    if !uuid(&id.to_ascii_lowercase())
        || !todo
            .get("content")
            .is_some_and(serde_json::Value::is_string)
    {
        return Err("INVALID_NORMAL_TODO");
    }
    let created = todo
        .get("created_at")
        .and_then(serde_json::Value::as_str)
        .filter(|text| time_millis(text).is_some())
        .ok_or("INVALID_TODO_CREATED_AT")?
        .to_owned();
    let missing_update = match todo.get("updated_at") {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(text)) if text.is_empty() => true,
        Some(serde_json::Value::String(text)) if time_millis(text).is_some() => false,
        _ => return Err("INVALID_TODO_UPDATED_AT"),
    };
    if missing_update {
        todo.insert("updated_at".into(), serde_json::Value::String(created));
    }
    for (key, default) in [
        ("date", serde_json::Value::Null),
        ("time", serde_json::Value::Null),
        ("completed_at", serde_json::Value::Null),
        ("label", serde_json::Value::Null),
        ("reminder", serde_json::Value::Null),
        ("completed", serde_json::json!(false)),
        ("deleted", serde_json::json!(false)),
        ("order", serde_json::json!(0)),
        ("recurring", serde_json::json!("none")),
        ("task_type", serde_json::json!("normal")),
        ("completed_dates", serde_json::json!([])),
        ("target_count", serde_json::Value::Null),
        ("subtasks", serde_json::json!([])),
    ] {
        todo.entry(key).or_insert(default);
    }
    if todo.get("task_type").and_then(serde_json::Value::as_str) != Some("normal") {
        return Err("NON_NORMAL_TODO_NOT_SUPPORTED");
    }
    if ["date", "time"]
        .iter()
        .any(|key| !todo[*key].is_null() && !todo[*key].is_string())
        || ["completed", "deleted"]
            .iter()
            .any(|key| !todo[*key].is_boolean())
        || !todo["order"].as_f64().is_some_and(f64::is_finite)
        || !todo["recurring"].is_string()
        || !optional_time(&todo["completed_at"])
        || !todo["completed_dates"]
            .as_array()
            .is_some_and(|items| items.iter().all(serde_json::Value::is_string))
    {
        return Err("INVALID_NORMAL_TODO_FIELDS");
    }
    if !todo["target_count"]
        .as_f64()
        .is_some_and(|value| value > 0.0 && value <= 9007199254740991.0 && value.fract() == 0.0)
    {
        todo.insert("target_count".into(), serde_json::Value::Null);
    }
    let label = todo["label"]
        .as_str()
        .map(|text| text.trim_matches(js_whitespace).nfc().collect::<String>())
        .filter(|text| !text.is_empty() && text != "未分类");
    todo.insert(
        "label".into(),
        label.map_or(serde_json::Value::Null, serde_json::Value::String),
    );
    let subtasks = todo
        .get_mut("subtasks")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or("INVALID_TODO_SUBTASKS")?;
    for subtask in subtasks {
        let subtask = subtask.as_object_mut().ok_or("INVALID_TODO_SUBTASK")?;
        if !["id", "content"]
            .iter()
            .all(|key| subtask.get(*key).is_some_and(serde_json::Value::is_string))
        {
            return Err("INVALID_TODO_SUBTASK");
        }
        subtask
            .entry("completed")
            .or_insert(serde_json::json!(false));
        subtask
            .entry("completed_at")
            .or_insert(serde_json::Value::Null);
        if !subtask["completed"].is_boolean() || !optional_time(&subtask["completed_at"]) {
            return Err("INVALID_TODO_SUBTASK");
        }
    }
    let reminder = todo.get_mut("reminder").unwrap();
    if !reminder.is_null() {
        let reminder = reminder.as_object_mut().ok_or("INVALID_TODO_REMINDER")?;
        if !reminder
            .get("reminder_time")
            .is_some_and(serde_json::Value::is_string)
        {
            return Err("INVALID_TODO_REMINDER");
        }
        reminder
            .entry("reminder_date")
            .or_insert(serde_json::Value::Null);
        reminder
            .entry("repeat_daily")
            .or_insert(serde_json::json!(false));
        if (!reminder["reminder_date"].is_null() && !reminder["reminder_date"].is_string())
            || !reminder["repeat_daily"].is_boolean()
        {
            return Err("INVALID_TODO_REMINDER");
        }
    }
    Ok(result)
}

fn normalized_learning_key(value: &serde_json::Value) -> Result<String> {
    canonical_learning(&parse(
        serde_json::to_string(value)
            .map_err(|_| "INVALID_TODO_JSON")?
            .as_bytes(),
    )?)
}

fn normal_todos(records: &[serde_json::Value]) -> Result<Vec<serde_json::Value>> {
    let mut winners: HashMap<String, (serde_json::Value, i64, String, String)> = HashMap::new();
    for original in records {
        let normalized = normalize_todo(original)?;
        let id = normalized["id"].as_str().unwrap().to_owned();
        let time = time_millis(normalized["updated_at"].as_str().unwrap()).unwrap();
        let mut content = normalized.clone();
        let content_fields = content.as_object_mut().unwrap();
        for field in ["id", "created_at", "updated_at"] {
            content_fields.remove(field);
        }
        let business_key = normalized_learning_key(&content)?;
        // 只在业务内容等价后用规范字节摘要消除表示歧义，不比较原始时间字符串先后。
        let raw_json = serde_json::to_string(&normalized).map_err(|_| "INVALID_TODO_JSON")?;
        let full_key = sha256(canonical(&parse(raw_json.as_bytes())?)?.as_bytes());
        let replace = winners
            .get(&id)
            .is_none_or(|(_, old_time, old_business, old_full)| {
                time.cmp(old_time)
                    .then_with(|| business_key.encode_utf16().cmp(old_business.encode_utf16()))
                    .then_with(|| full_key.encode_utf16().cmp(old_full.encode_utf16()))
                    .is_gt()
            });
        // 整条选择，没有 deleted 额外优先级，也不拼接并发字段。
        if replace {
            winners.insert(id, (normalized, time, business_key, full_key));
        }
    }
    let mut ids: Vec<_> = winners.keys().cloned().collect();
    ids.sort();
    Ok(ids
        .into_iter()
        .map(|id| winners.remove(&id).unwrap().0)
        .collect())
}

pub fn business(domain: &str, records: &[serde_json::Value]) -> Result<Vec<serde_json::Value>> {
    if domain == "todo" {
        return normal_todos(records);
    }
    if domain != "review" && domain != "rating" {
        return Err("INVALID_BUSINESS_DOMAIN");
    }
    let mut winners: HashMap<String, (serde_json::Value, i64, bool, bool, String)> = HashMap::new();
    for original in records {
        let value = parse(
            serde_json::to_string(original)
                .map_err(|_| "INVALID_BUSINESS_RECORD")?
                .as_bytes(),
        )?;
        let date = value
            .text("date")
            .filter(|s| !s.is_empty())
            .ok_or("INVALID_BUSINESS_RECORD")?;
        let time = value
            .text("updated_at")
            .filter(|s| !s.is_empty())
            .or_else(|| value.text("created_at"))
            .and_then(time_millis)
            .ok_or("INVALID_BUSINESS_TIME")?;
        let deleted = matches!(value.get("deleted"), Some(Value::Bool(true)));
        let clear = domain == "rating" && matches!(value.get("score"), Some(Value::Null));
        let content = canonical_learning(&value)?;
        let replace =
            winners
                .get(date)
                .is_none_or(|(_, old_time, old_deleted, old_clear, old_content)| {
                    (time, deleted, clear)
                        .cmp(&(*old_time, *old_deleted, *old_clear))
                        .then_with(|| content.encode_utf16().cmp(old_content.encode_utf16()))
                        .is_gt()
                });
        if replace {
            winners.insert(
                date.to_owned(),
                (original.clone(), time, deleted, clear, content),
            );
        }
    }
    let mut dates: Vec<_> = winners.keys().cloned().collect();
    dates.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(dates
        .into_iter()
        .map(|date| winners.remove(&date).unwrap().0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_keys_are_rejected_before_map_materialization() {
        for input in [
            r#"{"x":1,"x":2}"#,
            r#"{"x":1,"\u0078":2}"#,
            r#"{"outer":{"x":1,"x":2}}"#,
        ] {
            assert!(canonicalize(input).is_err());
        }
    }

    #[test]
    fn unicode_and_strict_utf8() {
        assert_eq!(
            canonicalize(r#"{"\ue000":1,"\ud83d\ude00":2}"#).unwrap(),
            "{\"😀\":2,\"\u{e000}\":1}"
        );
        assert_eq!(
            canonicalize(r#"["\ud83d\ude00","\u0000","\/","\b"]"#).unwrap(),
            "[\"😀\",\"\\u0000\",\"/\",\"\\b\"]"
        );
        for input in [
            r#""\ud800""#,
            r#""\udc00""#,
            r#""\ufdd0""#,
            r#""\udbff\udfff""#,
        ] {
            assert!(canonicalize(input).is_err());
        }
        assert!(decode_canonical(&[0xc0, 0xaf]).is_err());
        assert!(decode_canonical(&[0xef, 0xbb, 0xbf, b'0']).is_err());
        assert!(decode_canonical(b" 0").is_err());
    }

    #[test]
    fn binary64_ecmascript_edges() {
        for (bits, expected) in [
            ("0000000000000000", "0"),
            ("8000000000000000", "0"),
            ("0000000000000001", "5e-324"),
            ("8000000000000001", "-5e-324"),
            ("7fefffffffffffff", "1.7976931348623157e+308"),
            ("ffefffffffffffff", "-1.7976931348623157e+308"),
            ("4340000000000000", "9007199254740992"),
            ("c340000000000000", "-9007199254740992"),
            ("4430000000000000", "295147905179352830000"),
            ("44b52d02c7e14af5", "9.999999999999997e+22"),
            ("44b52d02c7e14af6", "1e+23"),
            ("44b52d02c7e14af7", "1.0000000000000001e+23"),
            ("444b1ae4d6e2ef4e", "999999999999999700000"),
            ("444b1ae4d6e2ef4f", "999999999999999900000"),
            ("444b1ae4d6e2ef50", "1e+21"),
            ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
            ("3eb0c6f7a0b5ed8d", "0.000001"),
            ("41b3de4355555553", "333333333.3333332"),
            ("41b3de4355555554", "333333333.33333325"),
            ("41b3de4355555555", "333333333.3333333"),
            ("41b3de4355555556", "333333333.3333334"),
            ("41b3de4355555557", "333333333.33333343"),
            ("becbf647612f3696", "-0.0000033333333333333333"),
            ("43143ff3c1cb0959", "1424953923781206.2"),
        ] {
            assert_eq!(number_from_hex(bits).unwrap(), expected, "{bits}");
        }
        for bits in ["7ff0000000000000", "fff0000000000000", "7ff8000000000000"] {
            assert!(number_from_hex(bits).is_err());
        }
    }

    #[test]
    fn valid_calendar_and_millisecond_comparison() {
        assert_eq!(time_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(time_millis("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(time_millis("1970-01-01T00:00:00.123999Z"), Some(123));
        assert!(time_millis("0000-02-29T00:00:00Z").is_some());
        for value in [
            "2026-02-29T00:00:00Z",
            "2026-11-31T00:00:00Z",
            "2026-11-05T24:00:00Z",
            "2026-11-05T00:00:60Z",
            "2026-11-05T00:00:00+24:00",
            "2026-11-05T00:00:00",
        ] {
            assert!(time_millis(value).is_none(), "{value}");
        }
    }

    #[test]
    fn business_clear_and_deleted_precedence_and_utf16_lengths() {
        let a = serde_json::json!({"id":"a","date":"2026-11-05","updated_at":"2026-11-05T00:00:00Z","created_at":"2026-11-05T00:00:00Z","deleted":false,"score":5});
        let mut clear = a.clone();
        clear["score"] = serde_json::Value::Null;
        assert_eq!(
            business("rating", &[a.clone(), clear.clone()]).unwrap(),
            vec![clear.clone()]
        );
        let mut deleted = a;
        deleted["deleted"] = true.into();
        assert_eq!(
            business("rating", &[clear, deleted.clone()]).unwrap(),
            vec![deleted]
        );
        assert_eq!(
            canonical_learning(&Value::String("😀".into())).unwrap(),
            "s2:😀"
        );
    }

    fn sealed(value: &serde_json::Value) -> Vec<u8> {
        canonicalize(&serde_json::to_string(value).unwrap())
            .unwrap()
            .into_bytes()
    }

    fn dataset() -> (serde_json::Value, Vec<u8>, Vec<u8>) {
        let id = "f1234567-1234-4234-8234-123456789abc";
        let baseline =
            sealed(&serde_json::json!({"protocol":PROTOCOL,"dataset_id":id,"data":{"notes":{}}}));
        let descriptor = sealed(
            &serde_json::json!({"protocol":PROTOCOL,"dataset_id":id,"baseline_sha256":sha256(&baseline),
            "data_schema_version":1,"operation_set":"lab-note/1","created_at":"2026-11-05T00:00:00Z"}),
        );
        let pin = serde_json::json!({"protocol":PROTOCOL,"dataset_id":id,"descriptor_sha256":sha256(&descriptor),
            "baseline_sha256":sha256(&baseline),"namespace":format!("record-sync/{id}/")});
        (pin, descriptor, baseline)
    }

    fn record_body(pin: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({"protocol":PROTOCOL,"dataset_id":pin["dataset_id"],"descriptor_sha256":pin["descriptor_sha256"],
            "id":"10000000-0000-4000-8000-000000000003","actor_id":"11111111-1111-4111-8111-111111111111",
            "created_at":"2026-11-05T08:00:00+08:00","lamport":1,"parents":[],"operations":[{"type":"lab.note.set","key":"中","value":"文"}]})
    }

    fn validate_body(pin: &serde_json::Value, body: &serde_json::Value) -> Result<()> {
        let bytes = sealed(body);
        let name = format!(
            "records/{}.{}.json",
            body["id"].as_str().unwrap(),
            sha256(&bytes)
        );
        verify_record(pin, &name, &bytes)
    }

    #[test]
    fn exact_dataset_pin_and_hash_binding() {
        let (pin, descriptor, baseline) = dataset();
        assert!(validate_join(&pin, &descriptor, &baseline).is_ok());
        let mut bad = pin.clone();
        bad["dataset_id"] = serde_json::json!([pin["dataset_id"]]);
        assert!(validate_join(&bad, &descriptor, &baseline).is_err());
        let mut bad = pin.clone();
        bad["unexpected"] = true.into();
        assert!(validate_join(&bad, &descriptor, &baseline).is_err());
        assert!(validate_join(&pin, b"{}", &baseline).is_err());
        assert!(validate_join(&pin, &descriptor, b"[]").is_err());
    }

    #[test]
    fn record_fields_parent_order_and_lab_operation_are_strict() {
        let (pin, _, _) = dataset();
        let body = record_body(&pin);
        assert!(validate_body(&pin, &body).is_ok());
        for fields in [
            serde_json::json!({"extra":true}),
            serde_json::json!({"lamport":9007199254740992u64}),
            serde_json::json!({"created_at":"2026-02-30T00:00:00Z"}),
            serde_json::json!({"operations":[{"type":"todo.add","key":"x","value":"y"}]}),
            serde_json::json!({"actor_id":["11111111-1111-4111-8111-111111111111"]}),
        ] {
            let mut bad = body.clone();
            for (key, value) in fields.as_object().unwrap() {
                bad[key] = value.clone();
            }
            assert!(validate_body(&pin, &bad).is_err());
        }
        let a = serde_json::json!({"id":"10000000-0000-4000-8000-000000000001","sha256":"a".repeat(64)});
        let b = serde_json::json!({"id":"10000000-0000-4000-8000-000000000002","sha256":"b".repeat(64)});
        let mut bad = body.clone();
        bad["parents"] = serde_json::json!([b, a]);
        assert!(validate_body(&pin, &bad).is_err());
        let mut bad = body.clone();
        bad["parents"] = serde_json::json!([a, a]);
        assert!(validate_body(&pin, &bad).is_err());
        let mut bad = body;
        bad["parents"] = serde_json::json!([{"id":bad["id"],"sha256":"c".repeat(64)}]);
        assert!(validate_body(&pin, &bad).is_err());
    }

    #[test]
    fn review_tie_uses_utf16_comparison_not_unicode_scalar_order() {
        let a = serde_json::json!({"id":"same","date":"2026-11-05","created_at":"2026-11-05T00:00:00Z",
            "updated_at":"2026-11-05T00:00:00Z","deleted":false,"fact":"😀"});
        let mut b = a.clone();
        b["fact"] = "\u{e000}x".into();
        assert_eq!(business("review", &[a, b.clone()]).unwrap(), vec![b]);
    }

    #[test]
    fn malformed_json_and_resource_limits_are_diagnostics() {
        for input in [
            "01",
            "[1,]",
            "{\"x\":}",
            "truefalse",
            "1e400",
            "-1e400",
            "1e",
            "+1",
        ] {
            assert!(canonicalize(input).is_err());
        }
        assert!(canonicalize(&("[".repeat(130) + "0" + &"]".repeat(130))).is_err());
        assert!(canonicalize(&("\"".to_owned() + &"x".repeat(MAX_BYTES) + "\"")).is_err());
    }

    fn normal_task() -> serde_json::Value {
        serde_json::json!({"id":"10000000-0000-4000-8000-000000000001","content":"aaa","created_at":"2026-11-05T00:00:00Z"})
    }

    #[test]
    fn todo_defaults_label_nfc_and_unknown_nested_fields_are_preserved() {
        let mut input = normal_task();
        input["updated_at"] = serde_json::Value::Null;
        input["label"] = "\u{feff}\u{a0}e\u{301}\u{3000}".into();
        input["target_count"] = 1.5.into();
        input["custom"] = serde_json::json!({"nested":[3,{"preserved":true}],"text":" e\u{301} "});
        input["subtasks"] = serde_json::json!([{"id":"","content":"","extra":{"keep":true}},{"id":"second","content":"second"}]);
        input["reminder"] = serde_json::json!({"reminder_time":"","extra":{"keep":true}});
        let before = input.clone();
        let output = business("todo", &[input.clone()]).unwrap().remove(0);
        assert_eq!(output["updated_at"], input["created_at"]);
        assert_eq!(output["label"], "é");
        assert!(output["target_count"].is_null());
        assert_eq!(output["completed"], false);
        assert_eq!(output["deleted"], false);
        assert_eq!(output["order"], 0);
        assert_eq!(output["task_type"], "normal");
        assert!(output["date"].is_null());
        assert_eq!(output["subtasks"][0]["id"], "");
        assert_eq!(output["subtasks"][0]["completed"], false);
        assert!(output["subtasks"][0]["completed_at"].is_null());
        assert_eq!(
            output["subtasks"][0]["extra"],
            input["subtasks"][0]["extra"]
        );
        assert_eq!(output["reminder"]["repeat_daily"], false);
        assert!(output["reminder"]["reminder_date"].is_null());
        assert_eq!(output["reminder"]["extra"], input["reminder"]["extra"]);
        assert_eq!(output["custom"], input["custom"]);
        assert_eq!(input, before);
    }

    #[test]
    fn todo_chooses_whole_record_by_actual_millisecond_time_not_field_delta() {
        let mut a = normal_task();
        a["content"] = "A content".into();
        a["label"] = "old label".into();
        a["updated_at"] = "2026-11-05T10:00:00+08:00".into();
        let mut b = normal_task();
        b["content"] = "base content".into();
        b["label"] = "B label".into();
        b["updated_at"] = "2026-11-05T03:00:00Z".into();
        let expected = normalize_todo(&b).unwrap();
        assert_eq!(
            business("todo", &[a.clone(), b.clone()]).unwrap(),
            vec![expected.clone()]
        );
        assert_eq!(business("todo", &[b, a]).unwrap(), vec![expected]);
    }

    #[test]
    fn todo_same_millisecond_business_rank_precedes_timestamp_text_and_metadata() {
        let mut a = normal_task();
        a["content"] = "aaa".into();
        a["created_at"] = "2099-01-01T00:00:00Z".into();
        a["updated_at"] = "2026-11-05T08:00:00.000999+08:00".into();
        let mut b = normal_task();
        b["content"] = "zzz".into();
        b["created_at"] = "2000-01-01T00:00:00Z".into();
        b["updated_at"] = "2026-11-05T00:00:00.000001Z".into();
        let expected = normalize_todo(&b).unwrap();
        for records in [
            vec![a.clone(), b.clone()],
            vec![b.clone(), a.clone()],
            vec![a.clone(), b.clone(), a, b],
        ] {
            assert_eq!(business("todo", &records).unwrap(), vec![expected.clone()]);
        }
    }

    #[test]
    fn todo_does_not_give_deletion_permanent_or_extra_tie_priority() {
        let mut deleted = normal_task();
        deleted["deleted"] = true.into();
        deleted["updated_at"] = "2026-11-05T00:00:00Z".into();
        let mut active = normal_task();
        active["content"] = "zzz".into();
        active["updated_at"] = "2026-11-05T00:00:00Z".into();
        assert_eq!(
            business("todo", &[deleted.clone(), active.clone()]).unwrap()[0]["deleted"],
            false
        );
        active["updated_at"] = "2026-11-05T00:00:01Z".into();
        assert_eq!(
            business("todo", &[active.clone(), deleted.clone()]).unwrap(),
            vec![normalize_todo(&active).unwrap()]
        );
        deleted["updated_at"] = "2026-11-05T00:00:02Z".into();
        assert_eq!(
            business("todo", &[active, deleted]).unwrap()[0]["deleted"],
            true
        );
    }

    #[test]
    fn todo_identical_business_content_uses_digest_only_as_metadata_fallback() {
        let mut a = normal_task();
        a["updated_at"] = "2026-11-05T00:00:00Z".into();
        let mut b = a.clone();
        b["created_at"] = "2026-01-01T08:00:00+08:00".into();
        let expected = normalize_todo(&a).unwrap();
        assert_eq!(
            business("todo", &[a.clone(), b.clone()]).unwrap(),
            vec![expected.clone()]
        );
        assert_eq!(business("todo", &[b, a]).unwrap(), vec![expected]);
    }

    #[test]
    fn todo_main_ids_allow_uppercase_without_merging_case_distinct_identity() {
        let mut lower = normal_task();
        lower["id"] = "abcdef01-0000-4000-8000-000000000001".into();
        lower["content"] = "".into();
        let mut upper = lower.clone();
        upper["id"] = "ABCDEF01-0000-4000-8000-000000000001".into();
        let output = business("todo", &[lower.clone(), upper.clone()]).unwrap();
        assert_eq!(output.len(), 2);
        assert_eq!(output[0]["id"], upper["id"]);
        assert_eq!(output[1]["id"], lower["id"]);
    }

    #[test]
    fn todo_invalid_target_counts_and_labels_use_explicit_defaults_only() {
        for target in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("2"),
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::json!(9007199254740992u64),
        ] {
            let mut task = normal_task();
            task["target_count"] = target;
            assert!(business("todo", &[task]).unwrap()[0]["target_count"].is_null());
        }
        for label in [
            serde_json::json!(" 未分类 "),
            serde_json::json!(false),
            serde_json::json!([]),
            serde_json::json!("\u{2009}"),
            serde_json::Value::Null,
        ] {
            let mut task = normal_task();
            task["label"] = label;
            assert!(business("todo", &[task]).unwrap()[0]["label"].is_null());
        }
        let mut task = normal_task();
        task["label"] = "\u{200b}".into();
        task["target_count"] = 2.into();
        let result = business("todo", &[task]).unwrap();
        assert_eq!(result[0]["label"], "\u{200b}");
        assert_eq!(result[0]["target_count"], 2);
    }

    #[test]
    fn todo_rejects_non_normal_types_and_explicit_invalid_values() {
        for fields in [
            serde_json::json!({"task_type":"weekly_checkin"}),
            serde_json::json!({"task_type":"monthly_checkin"}),
            serde_json::json!({"task_type":null}),
            serde_json::json!({"updated_at":false}),
            serde_json::json!({"date":{}}),
            serde_json::json!({"completed":null}),
            serde_json::json!({"order":"0"}),
            serde_json::json!({"recurring":null}),
            serde_json::json!({"subtasks":null}),
            serde_json::json!({"completed_at":"2026-02-30T00:00:00Z"}),
            serde_json::json!({"subtasks":[{"id":"","content":"","completed":null}]}),
            serde_json::json!({"subtasks":[{"id":"","content":"","completed_at":"2026-11-05T00:00:00"}]}),
            serde_json::json!({"reminder":{"reminder_time":"09:00","repeat_daily":null}}),
        ] {
            let mut task = normal_task();
            for (key, value) in fields.as_object().unwrap() {
                task[key] = value.clone();
            }
            assert!(business("todo", &[task]).is_err(), "{fields}");
        }
        for updated in [serde_json::Value::Null, serde_json::json!("")] {
            let mut task = normal_task();
            task["updated_at"] = updated;
            let result = business("todo", &[task]).unwrap();
            assert_eq!(result[0]["updated_at"], result[0]["created_at"]);
        }
    }
}
