//! One-shot, unshipped nonproduction Gate 0 client; never an Agent executable.
//! Requires a separately approved disposable identity and preview Worker.
#[cfg(unix)]
mod unix_probe {
    use rca_native_agent::gate0_probe::Gate0Probe;
    use rca_native_agent::session::connect_authenticated;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;
    use url::Url;

    fn preview_endpoint(value: &str) -> bool {
        let Ok(url) = Url::parse(value) else {
            return false;
        };
        let Some(host) = url.host_str() else {
            return false;
        };
        url.scheme() == "https"
            && host.starts_with("rca-rust-gate0-")
            && host.ends_with(".workers.dev")
            && url.port().is_none()
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    }

    fn run() -> Result<(), &'static str> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.len() != 4 {
            return Err("usage: gate0_nonprod <https://rca-rust-gate0-*.workers.dev/> <device_uuid> <absolute_private_probe_root> <frames_1_to_8>");
        }
        let endpoint = &args[0];
        if !preview_endpoint(endpoint) {
            return Err(
                "only a dedicated disposable rca-rust-gate0-*.workers.dev preview is allowed",
            );
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
            .map_err(|_| "preview Worker did not approve this test identity or WebSocket")?;
        for _ in 0..count {
            let incoming = socket
                .receive_text()
                .map_err(|_| "preview WebSocket ended before expected frame count")?;
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
        use super::preview_endpoint;

        #[test]
        fn only_explicit_nonproduction_preview_host_is_accepted() {
            assert!(preview_endpoint(
                "https://rca-rust-gate0-abc.lirtual.workers.dev/"
            ));
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
                assert!(!preview_endpoint(url), "{url}");
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
