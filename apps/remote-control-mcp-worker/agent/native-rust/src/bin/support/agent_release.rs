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
pub(super) struct Asset {
    pub name: String,
    pub url: String,
    pub digest: String,
    pub size: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Release {
    pub tag: String,
    pub manifest: Asset,
    pub assets: Vec<Asset>,
}

impl Release {
    pub(super) fn asset_for_target(&self, target: &str) -> Option<&Asset> {
        let extension = if target == "windows-x64" {
            "zip"
        } else {
            "tar.gz"
        };
        let name = format!("remote-control-agent-{}-{target}.{extension}", self.tag);
        self.assets.iter().find(|asset| asset.name == name)
    }
}

const MANIFEST_NAME: &str = "remote-control-agent-manifest.txt";

fn parse_asset(value: &Value, tag: &str, name: &str, max_size: u64) -> Result<Asset, ()> {
    let digest = value["digest"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .ok_or(())?;
    let size = value["size"]
        .as_u64()
        .filter(|n| (1..=max_size).contains(n))
        .ok_or(())?;
    let url = format!("{BASE}/download/{tag}/{name}");
    if value["name"] != name
        || value["state"] != "uploaded"
        || value["browser_download_url"].as_str() != Some(url.as_str())
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(());
    }
    Ok(Asset {
        name: name.to_owned(),
        url,
        digest: digest.to_owned(),
        size,
    })
}

fn trusted_https_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    matches!(
        url.host_str(),
        Some(
            "github.com"
                | "release-assets.githubusercontent.com"
                | "objects.githubusercontent.com"
                | "api.github.com"
        )
    ) && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port().is_none_or(|port| port == 443)
}

pub(super) fn verify_asset_bytes(asset: &Asset, bytes: &[u8]) -> Result<(), ()> {
    use sha2::{Digest, Sha256};
    if bytes.len() as u64 != asset.size || format!("{:x}", Sha256::digest(bytes)) != asset.digest {
        return Err(());
    }
    Ok(())
}

pub(super) fn verify_manifest(release: &Release, raw: &[u8]) -> Result<(), ()> {
    if raw.len() > 1024 || !raw.is_ascii() {
        return Err(());
    }
    let text = std::str::from_utf8(raw).map_err(|_| ())?;
    let mut lines = text.lines();
    let header: Vec<_> = lines.next().ok_or(())?.split_ascii_whitespace().collect();
    if header.as_slice() != ["rca-release-v1", release.tag.as_str()] {
        return Err(());
    }
    let mut seen = [false; 5];
    let mut count = 0usize;
    for line in lines {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        if fields.len() != 3 || count >= TARGETS.len() {
            return Err(());
        }
        let index = TARGETS
            .iter()
            .position(|target| *target == fields[0])
            .ok_or(())?;
        if seen[index] {
            return Err(());
        }
        let size = fields[1].parse::<u64>().map_err(|_| ())?;
        if size.to_string() != fields[1]
            || fields[2].len() != 64
            || !fields[2]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(());
        }
        let asset = release.asset_for_target(fields[0]).ok_or(())?;
        if asset.size != size || asset.digest != fields[2] {
            return Err(());
        }
        seen[index] = true;
        count += 1;
    }
    if count != TARGETS.len() || !seen.iter().all(|value| *value) {
        return Err(());
    }
    Ok(())
}

pub(super) fn download_asset(asset: &Asset) -> Result<Vec<u8>, ()> {
    use std::io::Read;
    if !trusted_https_url(&asset.url) || !(1..=180_000_000).contains(&asset.size) {
        return Err(());
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || !trusted_https_url(attempt.url().as_str()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|_| ())?;
    let response = client
        .get(&asset.url)
        .header("Accept", "application/octet-stream")
        .header("User-Agent", "rca-native-agent")
        .send()
        .map_err(|_| ())?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|size| size != asset.size)
    {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(asset.size).map_err(|_| ())?);
    response
        .take(asset.size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    verify_asset_bytes(asset, &bytes)?;
    Ok(bytes)
}

pub(super) fn stable_version(tag: &str) -> Option<[u64; 3]> {
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
    let mut manifest = None;
    let mut platform_assets = Vec::with_capacity(TARGETS.len());
    for asset in assets {
        let name = asset["name"].as_str().ok_or(())?;
        if name == MANIFEST_NAME {
            if manifest.is_some() {
                return Err(());
            }
            manifest = Some(parse_asset(asset, tag, MANIFEST_NAME, 1024)?);
            continue;
        }
        let expected = TARGETS.iter().position(|target| {
            let extension = if *target == "windows-x64" {
                "zip"
            } else {
                "tar.gz"
            };
            name == format!("remote-control-agent-{tag}-{target}.{extension}")
        });
        let Some(index) = expected else {
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
        if seen[index] {
            return Err(());
        }
        platform_assets.push(parse_asset(asset, tag, name, 180_000_000)?);
        seen[index] = true;
    }
    if !seen.iter().all(|v| *v) {
        return Err(());
    }
    Ok(Release {
        tag: tag.to_owned(),
        manifest: manifest.ok_or(())?,
        assets: platform_assets,
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
        .header("X-GitHub-Api-Version", "2022-11-28")
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
    let release = parse_latest(&raw)?;
    let manifest = download_asset(&release.manifest)?;
    verify_manifest(&release, &manifest)?;
    Ok(release)
}

#[cfg(test)]
mod tests {
    use super::*;
    const MANIFEST: &str = concat!(
        "rca-release-v1 v0.1.61\n",
        "linux-x64-glibc 1024 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "linux-arm64-glibc 1024 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "windows-x64 1024 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "darwin-arm64 1024 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "darwin-x64 1024 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    );
    fn fixture() -> Value {
        use sha2::{Digest, Sha256};
        let tag = "v0.1.61";
        let mut assets = TARGETS.iter().map(|target| {
            let ext = if *target == "windows-x64" {"zip"} else {"tar.gz"};
            let name = format!("remote-control-agent-{tag}-{target}.{ext}");
            serde_json::json!({"name":name,"size":1024,"digest":format!("sha256:{}","a".repeat(64)),
                "state":"uploaded","browser_download_url":format!("{BASE}/download/{tag}/{name}")})
        }).collect::<Vec<_>>();
        assets.push(serde_json::json!({
            "name":MANIFEST_NAME,
            "size":MANIFEST.len(),
            "digest":format!("sha256:{:x}",Sha256::digest(MANIFEST.as_bytes())),
            "state":"uploaded",
            "browser_download_url":format!("{BASE}/download/{tag}/{MANIFEST_NAME}")
        }));
        serde_json::json!({"tag_name":tag,"immutable":true,"draft":false,"prerelease":false,
            "html_url":format!("{BASE}/tag/{tag}"),"assets":assets})
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
        let mut bad_manifest = valid.clone();
        let manifest = bad_manifest["assets"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|asset| asset["name"] == MANIFEST_NAME)
            .unwrap();
        manifest["digest"] = serde_json::json!("sha256:bad");
        assert!(parse(&bad_manifest).is_err());
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
    fn canonical_manifest_must_match_the_immutable_release_and_every_platform_asset() {
        let release = parse(&fixture()).unwrap();
        assert_eq!(release.assets.len(), 5);
        verify_manifest(&release, MANIFEST.as_bytes()).unwrap();

        let wrong_tag = MANIFEST.replace("v0.1.61", "v0.1.60");
        assert!(verify_manifest(&release, wrong_tag.as_bytes()).is_err());
        let wrong_size = MANIFEST.replacen(" 1024 ", " 1025 ", 1);
        assert!(verify_manifest(&release, wrong_size.as_bytes()).is_err());
        let wrong_digest = MANIFEST.replacen(&"a".repeat(64), &"b".repeat(64), 1);
        assert!(verify_manifest(&release, wrong_digest.as_bytes()).is_err());
        let missing = MANIFEST.lines().take(5).collect::<Vec<_>>().join("\n");
        assert!(verify_manifest(&release, missing.as_bytes()).is_err());
        let duplicate = format!("{MANIFEST}{}", MANIFEST.lines().nth(1).unwrap());
        assert!(verify_manifest(&release, duplicate.as_bytes()).is_err());
        let unknown = MANIFEST.replace("darwin-x64", "freebsd-x64");
        assert!(verify_manifest(&release, unknown.as_bytes()).is_err());
        assert!(verify_manifest(&release, &vec![b' '; 1025]).is_err());
    }

    #[test]
    fn release_download_verification_binds_exact_bytes_and_trusted_https_origins() {
        use sha2::{Digest, Sha256};
        let bytes = b"verified archive";
        let asset = Asset {
            name: "remote-control-agent-v0.1.61-darwin-arm64.tar.gz".to_owned(),
            url: format!(
                "{BASE}/download/v0.1.61/remote-control-agent-v0.1.61-darwin-arm64.tar.gz"
            ),
            digest: format!("{:x}", Sha256::digest(bytes)),
            size: bytes.len() as u64,
        };
        verify_asset_bytes(&asset, bytes).unwrap();
        assert!(verify_asset_bytes(&asset, b"different archive").is_err());
        assert!(verify_asset_bytes(&asset, b"short").is_err());

        for (url, trusted) in [
            (
                "https://github.com/lirtual/mcp-workers/releases/download/v0.1.61/a.tar.gz",
                true,
            ),
            (
                "https://release-assets.githubusercontent.com/path?sig=opaque",
                true,
            ),
            (
                "https://objects.githubusercontent.com/path?sig=opaque",
                true,
            ),
            ("http://github.com/lirtual/mcp-workers/a", false),
            ("https://evil.example/a", false),
            ("https://user@github.com/a", false),
            ("https://github.com:444/a", false),
            ("https://github.com/a#fragment", false),
        ] {
            assert_eq!(trusted_https_url(url), trusted, "{url}");
        }
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
