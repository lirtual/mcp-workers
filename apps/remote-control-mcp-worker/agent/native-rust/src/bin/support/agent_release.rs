//! Read the existing GitHub Immutable Latest authority. No local release index.
use serde_json::Value;

const BASE: &str = "https://github.com/lirtual/mcp-workers/releases";
const TARGETS: [&str; 5] = [
    "linux-x64-glibc",
    "linux-arm64-glibc",
    "windows-x64",
    "darwin-arm64",
    "darwin-x64",
];

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Release {
    pub tag: String,
}

fn stable_version(tag: &str) -> Option<[u64; 3]> {
    let mut result = [0; 3];
    let mut parts = tag.strip_prefix('v')?.split('.');
    for value in &mut result {
        let part = parts.next()?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        *value = part.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

pub(super) fn parse_latest(raw: &[u8]) -> Result<Release, ()> {
    if raw.len() > 1_048_576 {
        return Err(());
    }
    let release: Value = serde_json::from_slice(raw).map_err(|_| ())?;
    let tag = release["tag_name"].as_str().ok_or(())?;
    stable_version(tag).ok_or(())?;
    if release["immutable"] != true
        || release["draft"] != false
        || release["prerelease"] != false
        || release
            .get("html_url")
            .is_some_and(|v| v.as_str() != Some(format!("{BASE}/tag/{tag}").as_str()))
    {
        return Err(());
    }
    let assets = release["assets"].as_array().ok_or(())?;
    if assets.len() > 64 {
        return Err(());
    }
    let mut seen = [false; 5];
    for asset in assets {
        let name = asset["name"].as_str().ok_or(())?;
        let expected = TARGETS.iter().position(|target| {
            let extension = if *target == "windows-x64" {
                "zip"
            } else {
                "tar.gz"
            };
            name == format!("remote-control-agent-{tag}-{target}.{extension}")
        });
        let Some(index) = expected else {
            // Reject another platform archive from a different tag/extension.
            // Other publisher assets do not select the product version.
            if name.starts_with("remote-control-agent-v")
                && TARGETS.iter().any(|target| {
                    ["zip", "tar.gz"]
                        .iter()
                        .any(|ext| name.ends_with(&format!("-{target}.{ext}")))
                })
            {
                return Err(());
            }
            continue;
        };
        let digest = asset["digest"]
            .as_str()
            .and_then(|s| s.strip_prefix("sha256:"))
            .ok_or(())?;
        if seen[index]
            || asset["state"] != "uploaded"
            || asset["browser_download_url"].as_str()
                != Some(format!("{BASE}/download/{tag}/{name}").as_str())
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !asset["size"]
                .as_u64()
                .is_some_and(|n| (1..=180_000_000).contains(&n))
        {
            return Err(());
        }
        seen[index] = true;
    }
    if !seen.iter().all(|v| *v) {
        return Err(());
    }
    Ok(Release {
        tag: tag.to_owned(),
    })
}

pub(super) fn observation(installed: Option<&str>, latest: Option<&Release>) -> Value {
    let mut result =
        serde_json::json!({"installed_version":installed,"latest_version":null,"status":"unknown"});
    let Some(current) = installed.and_then(stable_version) else {
        return result;
    };
    let Some(release) = latest else {
        return result;
    };
    let Some(next) = stable_version(&release.tag) else {
        return result;
    };
    result["latest_version"] = serde_json::json!(release.tag);
    result["status"] = serde_json::json!(if next > current {
        "update_available"
    } else if next == current {
        "up_to_date"
    } else {
        "older_latest"
    });
    result
}

#[cfg_attr(test, allow(dead_code))]
pub(super) fn latest() -> Result<Release, ()> {
    use std::io::Read;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| ())?;
    let response = client
        .get("https://api.github.com/repos/lirtual/mcp-workers/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "rca-native-agent")
        .send()
        .map_err(|_| ())?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > 1_048_576)
    {
        return Err(());
    }
    let mut raw = Vec::new();
    response
        .take(1_048_577)
        .read_to_end(&mut raw)
        .map_err(|_| ())?;
    parse_latest(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let tag = "v0.1.61";
        serde_json::json!({"tag_name":tag,"immutable":true,"draft":false,"prerelease":false,
            "html_url":format!("{BASE}/tag/{tag}"),
            "assets":TARGETS.iter().map(|target| {
                let ext = if *target == "windows-x64" {"zip"} else {"tar.gz"};
                let name = format!("remote-control-agent-{tag}-{target}.{ext}");
                serde_json::json!({"name":name,"size":1024,"digest":format!("sha256:{}","a".repeat(64)),
                    "state":"uploaded","browser_download_url":format!("{BASE}/download/{tag}/{name}")})
            }).collect::<Vec<_>>()})
    }
    fn parse(value: &Value) -> Result<Release, ()> {
        parse_latest(value.to_string().as_bytes())
    }
    #[test]
    fn latest_requires_immutable_complete_same_tag_platform_assets() {
        let valid = fixture();
        assert_eq!(parse(&valid).unwrap().tag, "v0.1.61");
        for (field, value) in [
            ("immutable", serde_json::json!(false)),
            ("draft", serde_json::json!(true)),
            ("prerelease", serde_json::json!(true)),
            ("tag_name", serde_json::json!("v0.1.61-rc.1")),
            ("html_url", serde_json::json!("https://example.com/release")),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(parse(&invalid).is_err(), "{field}");
        }
        for (field, value) in [
            ("size", serde_json::json!(180_000_001)),
            ("size", serde_json::json!(0)),
            ("size", serde_json::json!(1.5)),
            ("digest", serde_json::json!("sha256:bad")),
            ("state", serde_json::json!("new")),
            (
                "browser_download_url",
                serde_json::json!("https://example.com/asset"),
            ),
        ] {
            let mut invalid = valid.clone();
            invalid["assets"][0][field] = value;
            assert!(parse(&invalid).is_err(), "{field}");
        }
        let mut missing = valid.clone();
        missing["assets"].as_array_mut().unwrap().pop();
        assert!(parse(&missing).is_err());
        let mut duplicate = valid.clone();
        duplicate["assets"]
            .as_array_mut()
            .unwrap()
            .push(valid["assets"][0].clone());
        assert!(parse(&duplicate).is_err());
        let mut other = valid.clone();
        let mut asset = valid["assets"][0].clone();
        asset["name"] = serde_json::json!("remote-control-agent-v0.1.60-linux-x64-glibc.tar.gz");
        other["assets"].as_array_mut().unwrap().push(asset);
        assert!(parse(&other).is_err());
        assert!(parse_latest(&vec![b' '; 1_048_577]).is_err());
    }
    #[test]
    fn check_never_relabels_candidates_or_older_latest_as_current() {
        let release = parse(&fixture()).unwrap();
        for (installed, status) in [
            ("v0.1.60", "update_available"),
            ("v0.1.61", "up_to_date"),
            ("v0.1.62", "older_latest"),
            ("v0.1.61-rust-candidate.1", "unknown"),
            ("v00.1.60", "unknown"),
        ] {
            assert_eq!(
                observation(Some(installed), Some(&release))["status"],
                status
            );
        }
        assert_eq!(observation(Some("v0.1.60"), None)["status"], "unknown");
        assert_eq!(
            observation(None, Some(&release))["latest_version"],
            Value::Null
        );
    }
}
