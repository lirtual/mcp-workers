//! One-shot, unshipped nonproduction Gate 0 client; never an Agent executable.
//! Requires a separately approved test identity; preview, local Wrangler, or one-off tunnel.
#[cfg(unix)]
mod unix_probe {
    use rca_native_agent::gate0_probe::Gate0Probe;
    use rca_native_agent::session::connect_authenticated;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;
    use url::Url;

    fn approved_endpoint(value: &str, mode: &str) -> bool {
        if mode == "--local" {
            // Explicitly opt in to the isolated Wrangler dev port; never any other HTTP host.
            return value == "http://127.0.0.1:8777/";
        }
        let Ok(url) = Url::parse(value) else {
            return false;
        };
        let Some(host) = url.host_str() else {
            return false;
        };
        let permitted_host = if mode == "--quick-tunnel" {
            // A random, single-label Quick Tunnel, used only with the private test identity.
            host.strip_suffix(".trycloudflare.com").is_some_and(|name| {
                !name.is_empty()
                    && name.len() <= 63
                    && !name.starts_with('-')
                    && !name.ends_with('-')
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        } else {
            mode.is_empty() && host.starts_with("rca-rust-gate0-") && host.ends_with(".workers.dev")
        };
        url.scheme() == "https"
            && permitted_host
            && url.port().is_none()
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    }

    fn run() -> Result<(), &'static str> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mode = match args.as_slice() {
            [_, _, _, _] => "",
            [_, _, _, _, mode] if mode == "--local" || mode == "--quick-tunnel" => mode,
            _ => return Err("usage: gate0_nonprod <endpoint> <device_uuid> <private_probe_root> <frames_1_to_8> [--local|--quick-tunnel]"),
        };
        let endpoint = &args[0];
        if !approved_endpoint(endpoint, mode) {
            return Err("only a disposable preview, exact local Wrangler, or explicit Quick Tunnel is allowed");
        }
        let count = args[3]
            .parse::<usize>()
            .map_err(|_| "invalid frame count")?;
        if !(1..=8).contains(&count) {
            return Err("frame count must be 1..=8");
        }
        let root = Path::new(&args[2]);
        // Validate the disposable root *before* reading any identity material.
        let mut probe = Gate0Probe::new(root).map_err(|_| "untrusted test-only root")?;
        let identity = root.join("gate0-test-key.pem");
        let meta = fs::symlink_metadata(&identity).map_err(|_| "missing test-only identity")?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o077 != 0
            || meta.len() > 8_192
        {
            return Err("test-only identity must be a private, regular file");
        }
        let pem = fs::read_to_string(&identity).map_err(|_| "identity unreadable")?;
        let mut socket = connect_authenticated(endpoint, &pem, &args[1])
            .map_err(|_| "nonproduction Worker did not approve this test identity or WebSocket")?;
        for _ in 0..count {
            let incoming = socket
                .receive_text()
                .map_err(|_| "nonproduction WebSocket ended before expected frame count")?;
            let response = probe
                .handle(&incoming)
                .map_err(|_| "unexpected or out-of-scope preview frame")?;
            socket
                .send_text(&response)
                .map_err(|_| "preview response could not be sent")?;
        }
        // Do not reconnect or replay automatically. A second invocation must
        // obtain a fresh nonce and reuse the same private disposable receipt root.
        println!("handled {count} disposable test frames; no production operations");
        Ok(())
    }

    pub fn main() {
        if let Err(error) = run() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::approved_endpoint;

        #[test]
        fn only_explicit_nonproduction_endpoints_are_accepted() {
            assert!(approved_endpoint(
                "https://rca-rust-gate0-abc.lirtual.workers.dev/",
                ""
            ));
            assert!(approved_endpoint("http://127.0.0.1:8777/", "--local"));
            assert!(!approved_endpoint("http://127.0.0.1:8777/", ""));
            assert!(!approved_endpoint(
                "https://rca.lirtual.dpdns.org/",
                "--local"
            ));
            assert!(!approved_endpoint("http://127.0.0.1:8787/", "--local"));
            assert!(approved_endpoint(
                "https://one-off-test.trycloudflare.com/",
                "--quick-tunnel"
            ));
            for url in [
                "https://rca.lirtual.dpdns.org/",
                "http://one-off-test.trycloudflare.com/",
                "https://one-off-test.trycloudflare.com.evil.org/",
                "https://nested.one-off-test.trycloudflare.com/",
                "https://one-off-test.trycloudflare.com:8443/",
            ] {
                assert!(!approved_endpoint(url, "--quick-tunnel"), "{url}");
            }
            for url in [
                "https://rca.lirtual.dpdns.org/",
                "https://remote-control-mcp-worker.lirtual.workers.dev/",
                "http://rca-rust-gate0-abc.lirtual.workers.dev/",
                "https://rca-rust-gate0-abc.lirtual.workers.dev:8443/",
                "https://rca-rust-gate0-abc.lirtual.workers.dev/redirect",
                "https://rca-rust-gate0-abc.lirtual.workers.dev/?proof=bad",
                "https://user@rca-rust-gate0-abc.lirtual.workers.dev/",
                "https://rca-rust-gate0-abc.lirtual.workers.dev.evil.org/",
            ] {
                assert!(!approved_endpoint(url, ""), "{url}");
            }
        }
    }
}

#[cfg(unix)]
fn main() {
    unix_probe::main();
}

#[cfg(not(unix))]
fn main() {
    eprintln!("Gate 0 live preview is available only on disposable Unix test hosts");
    std::process::exit(1);
}
