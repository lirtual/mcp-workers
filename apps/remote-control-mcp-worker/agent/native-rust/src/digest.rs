//! Byte-compatible operation digest for the existing Node Agent's custom canonical JSON.
//! Do not replace this with serde_json::to_string on a map: JS sorts UTF-16 keys
//! and serializes all JSON numbers using ECMAScript Number formatting.
use serde_json::Value;
use sha2::{Digest, Sha256};

fn append_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let as_js_number = n.as_f64().expect("JSON number is representable as f64");
            // The wire protocol's JSON number is a JS Number, including integer rounding,
            // -0, exponent formatting and the 1e-6 / 1e21 notation boundaries.
            out.push_str(ryu_js::Buffer::new().format(as_js_number));
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("valid JSON string")),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                append_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            // JS Array.prototype.sort orders UTF-16 code units, not Rust UTF-8 bytes.
            let mut keys: Vec<_> = entries.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("valid JSON object key"));
                out.push(':');
                append_canonical(&entries[*key], out);
            }
            out.push('}');
        }
    }
}

pub fn canonical_json(value: &Value) -> String {
    let mut output = String::new();
    append_canonical(value, &mut output);
    output
}

/// Existing external seam: SHA-256(canonical({tool,arguments})), lowercase hex.
pub fn operation_digest(tool: &str, args: &Value) -> String {
    let body = serde_json::json!({"tool":tool,"arguments":args});
    let hash = Sha256::digest(canonical_json(&body).as_bytes());
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}
