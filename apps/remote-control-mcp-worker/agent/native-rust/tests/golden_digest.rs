//! Independent expected values sampled from Node 24's operationDigest
//! at main 351ef82235f2973e714f0a9ee12cdeb063d338d9 (Spec #914).
use rca_native_agent::digest::operation_digest;
use serde_json::Value;

#[test]
fn node24_canonical_digest_golden_examples() {
    let cases = [
        (
            "write_file",
            r#"{"z":1,"a":{"β":"é","😀":"line\nx","":"!"}}"#,
            "6fb9ba8f98e2fe51b387e860bb315ee84c5568c7181b3350fa44b0705e2383a9",
        ),
        (
            "create_directory",
            r#"{"number":[0,-0,1e-7,0.000001,100000000000000000000,1e+21,1.2345678901234567]}"#,
            "917824d3f577c314674e427f7bdf01e99b01a39e80d2220b348a3920e4a3d564",
        ),
        (
            "move_file",
            r#"{"unicode":{"中":"文","á":" ","control":"\b"}}"#,
            "1cf082dcb86146fd26bd37f75d738795e7494953a90e604a3e8fde83c7aa3985",
        ),
        (
            "delete_file",
            r#"{"nested":[{"b":true,"a":null},[],{}]}"#,
            "fa09ebd2472f334889b3cc6a6a819e06bf360b056845e39b0858634538f42ede",
        ),
        (
            "write_file",
            r#"{"big":9007199254740993,"exponent":1e-7}"#,
            "123b90e173864622344e4917c1e10a6e2a406795537c1258ca91335752165bd2",
        ),
    ];
    for (tool, input, expected) in cases {
        let args: Value = serde_json::from_str(input).unwrap();
        assert_eq!(operation_digest(tool, &args), expected, "{tool} {input}");
    }
}
