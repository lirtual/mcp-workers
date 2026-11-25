//! Native LaunchAgent contract. The exact configuration and observed process
//! must identify the installed program, never merely the service label.
use rca_native_agent::identity::valid_device_id;
use std::path::Path;

pub(super) const LABEL: &str = "org.mcp-workers.remote-control-agent";

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Registration {
    Absent,
    Present(Option<u32>),
    Unknown,
}

pub(super) fn registration(
    code: Option<i32>,
    stdout: &str,
    stderr: &str,
    executable: &Path,
) -> Registration {
    if code == Some(113) && stderr.contains("Could not find service") {
        return Registration::Absent;
    }
    if code != Some(0) {
        return Registration::Unknown;
    }
    let Some(executable) = executable.to_str() else {
        return Registration::Unknown;
    };
    let mut programs = stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("program = "));
    if programs.next() != Some(executable) || programs.next().is_some() {
        return Registration::Unknown;
    }
    let mut pids = stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("pid = "));
    let pid = pids
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid != 0);
    if pids.next().is_some() {
        return Registration::Unknown;
    }
    Registration::Present(pid)
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(super) fn native_plist(
    executable: &Path,
    endpoint: &str,
    generation: &str,
) -> Result<String, ()> {
    if !valid_device_id(generation) || !executable.is_absolute() {
        return Err(());
    }
    let origin = url::Url::parse(endpoint).map_err(|_| ())?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.port().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.as_str() != endpoint
    {
        return Err(());
    }
    let arguments = [
        executable.to_str().ok_or(())?,
        "--service",
        "--endpoint",
        endpoint,
        "--generation",
        generation,
    ];
    let arguments: String = arguments
        .iter()
        .map(|arg| format!("<string>{}</string>", xml(arg)))
        .collect();
    Ok(format!(concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
        "<plist version=\"1.0\"><dict>\n",
        "<key>Label</key><string>{}</string>\n",
        "<key>ProgramArguments</key><array>{}</array>\n",
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n"
    ), LABEL, arguments))
}

pub(super) fn installed_generation(
    raw: &str,
    executable: &Path,
    endpoint: &str,
) -> Result<String, ()> {
    let (_, last) = raw.rsplit_once("<string>").ok_or(())?;
    let (generation, _) = last.split_once("</string>").ok_or(())?;
    if raw != native_plist(executable, endpoint, generation)? {
        return Err(());
    }
    Ok(generation.to_owned())
}

// A local OFF request is durable before contacting the cloud. A cloud
// failure must not prevent local STOP; an uncertain launchd state must
// never be converted into a successful shutdown.
pub(super) fn stop_owned(
    persist: impl FnOnce() -> Result<(), ()>,
    cloud_stop: impl FnOnce() -> bool,
    mut observe: impl FnMut() -> Registration,
    bootout: impl FnOnce() -> bool,
    mut pause: impl FnMut(),
) -> Result<bool, ()> {
    persist()?;
    let cloud_confirmed = cloud_stop();
    match observe() {
        Registration::Unknown => return Err(()),
        Registration::Absent => return Ok(cloud_confirmed),
        Registration::Present(_) if !bootout() => return Err(()),
        Registration::Present(_) => (),
    }
    let mut absent = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    for attempt in 0..40 {
        if std::time::Instant::now() >= deadline {
            break;
        }
        match observe() {
            Registration::Unknown => return Err(()),
            Registration::Present(_) => absent = 0,
            Registration::Absent => {
                absent += 1;
                if absent == 2 {
                    return Ok(cloud_confirmed);
                }
            }
        }
        if attempt != 39 {
            pause();
        }
    }
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "123e4567-e89b-42d3-a456-426614174001";
    const ENDPOINT: &str = "https://example.invalid/";

    #[test]
    fn exact_native_plist_rejects_extra_arguments_and_foreign_program() {
        let exe = Path::new("/Users/test & owner/rca");
        let value = native_plist(exe, ENDPOINT, ID).unwrap();
        assert_eq!(
            installed_generation(&value, exe, ENDPOINT),
            Ok(ID.to_owned())
        );
        assert!(value.contains("test &amp; owner"));
        assert!(installed_generation(&value, Path::new("/tmp/foreign"), ENDPOINT).is_err());
        assert!(installed_generation(
            &value.replace("</array>", "<string>extra</string></array>"),
            exe,
            ENDPOINT
        )
        .is_err());
        assert!(
            installed_generation(&value.replace("<true/>", "<false/>"), exe, ENDPOINT).is_err()
        );
        assert!(native_plist(exe, "https://example.invalid:8443/", ID).is_err());
    }

    #[test]
    fn stop_preserves_off_intent_even_when_cloud_or_launchd_is_unconfirmed() {
        use std::cell::{Cell, RefCell};
        let events = RefCell::new(Vec::new());
        let observations = RefCell::new(
            vec![
                Registration::Present(Some(1)),
                Registration::Absent,
                Registration::Present(Some(1)),
                Registration::Absent,
                Registration::Absent,
            ]
            .into_iter(),
        );
        assert_eq!(
            stop_owned(
                || {
                    events.borrow_mut().push("persist");
                    Ok(())
                },
                || {
                    events.borrow_mut().push("cloud");
                    false
                },
                || {
                    events.borrow_mut().push("observe");
                    observations.borrow_mut().next().unwrap()
                },
                || {
                    events.borrow_mut().push("bootout");
                    true
                },
                || {},
            ),
            Ok(false)
        );
        assert_eq!(
            *events.borrow(),
            vec![
                "persist", "cloud", "observe", "bootout", "observe", "observe", "observe",
                "observe"
            ]
        );
        let persisted = Cell::new(false);
        assert!(stop_owned(
            || {
                persisted.set(true);
                Ok(())
            },
            || false,
            || Registration::Unknown,
            || panic!("unknown registration must not be stopped"),
            || {}
        )
        .is_err());
        assert!(persisted.get());
        assert!(stop_owned(
            || Err(()),
            || panic!("no durable OFF"),
            || panic!("no durable OFF"),
            || panic!("no durable OFF"),
            || {}
        )
        .is_err());
        assert!(stop_owned(
            || Ok(()),
            || true,
            || Registration::Present(Some(1)),
            || true,
            || {}
        )
        .is_err());
    }

    #[test]
    fn launchd_absence_and_exact_owned_registration_are_distinct() {
        let exe = Path::new("/Users/owner/rca");
        assert_eq!(
            registration(Some(113), "", "Could not find service", exe),
            Registration::Absent
        );
        assert_eq!(
            registration(Some(113), "", "Permission denied", exe),
            Registration::Unknown
        );
        assert_eq!(registration(None, "", "", exe), Registration::Unknown);
        assert_eq!(
            registration(Some(0), "program = /tmp/foreign\npid = 123\n", "", exe),
            Registration::Unknown
        );
        assert_eq!(
            registration(Some(0), "program = /Users/owner/rca\npid = 123\n", "", exe),
            Registration::Present(Some(123))
        );
        assert_eq!(
            registration(Some(0), "program = /Users/owner/rca\n", "", exe),
            Registration::Present(None)
        );
        assert_eq!(
            registration(
                Some(0),
                "program = /Users/owner/rca\npid = 123\npid = 456\n",
                "",
                exe
            ),
            Registration::Unknown
        );
    }
}
