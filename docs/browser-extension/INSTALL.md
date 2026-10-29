# Browser MCP 0.1.0 — installation and update

T8 development artifact for Spec #418 / #426. Not a complete product acceptance candidate.
No live Chrome/Edge, production, Access or Portal acceptance has been performed.
The service hostname is a placeholder; installation alone does not provision a service.

## Download and verify

The maintainer builds once from the reviewed checkout with
`python3 scripts/build-browser-extension.py`. Both browsers use the **same ZIP**.
The ZIP, `.zip.sha256`, `.zip.json` and these notices are retained with the existing
manual Release Worker run (Browser selection only). After separately authorized
publication, owners download those exact files from the repository's GitHub Release,
not an arbitrary third-party mirror. CI artifacts alone are not a published Release.
The JSON records Version, file hashes, aggregate source hash, Git revision and dirty
status. A dirty development build is not evidence of a trusted release commit.

Before extraction compare the ZIP SHA-256 with the trusted release record:
`sha256sum -c browser-mcp-extension-v0.1.0.zip.sha256` (Linux),
`shasum -a 256 browser-mcp-extension-v0.1.0.zip` (macOS), or
`Get-FileHash browser-mcp-extension-v0.1.0.zip -Algorithm SHA256` (PowerShell).
A matching hash establishes integrity relative to that record, not publisher identity.
Maintainers also run `python3 scripts/build-browser-extension.py --verify <zip>`
from the matching checkout to compare every ZIP byte against source.

## Install in each Profile

1. Use desktop Chrome **137+**, or desktop Edge with Chromium **137+** as the
   declared API floor. Edge behavior and the actual oldest working versions remain
   **Not run** until separate browser acceptance. The manifest enforces the Chromium
   floor; this is not evidence of Edge compatibility.
2. Extract into a permanent folder. Open `chrome://extensions` or `edge://extensions`,
   enable Developer Mode, choose **Load unpacked**, then select that folder containing
   `manifest.json`. No local Node/Python/build/runtime or Native Messaging host is
   required for the owner. Developer Mode and broad website/debugger permission
   warnings are part of this installation, not hidden setup steps.
3. Pin/open Browser MCP; verify the service address before entering a one-time code
   issued by the independently authenticated Browser MCP. Confirm locally. Pair each
   Profile separately; never copy another Profile's storage or credential.
4. Verify Endpoint alias, connection and control readiness separately. **Stop** persists
   locally before cloud confirmation. Only local Resume enables control again.

The public Manifest Key keeps the installation ID stable. It is not a credential,
Portal token, signing key or authorization check. It must remain unchanged on update.
The actual ID must be recorded during the separate Chrome and Edge acceptance.

## In-place update and failed-update recovery

1. Stop locally, record the Endpoint ID/Stop state and unresolved Operation IDs without
   copying secrets. Obtain and verify the new ZIP and retain the last verified ZIP.
2. Close current activity. Replace files in the **same installation directory** without
   removing the extension; Reload on the extensions page. Verify Version, same ID,
   same paired Endpoint and persistent Stop. Inspect readiness before local Resume.
   Updates must not automatically pair or enable. A service-worker restart can retain
   trusted session state; Reload/update/browser restart clears browser session storage.
3. An incompatible protocol, extension Version or capability handshake refuses control.
   Stop and inspect the matching Worker/extension release pair; never bypass the check.
4. If loading/update fails, keep Stop, restore the prior verified files in that same
   directory and Reload only if that version understands the current protocol and
   persisted state. Otherwise stay stopped and request a compatible forward fix.
   Worker rollback requires a separate approved manual release and compatibility review.
5. Never clear the DO, delete Unknown receipts, change the namespace or issue a new
   intent key to retry Unknown as a recovery shortcut. Code rollback cannot roll back
   website effects. Query the original receipt and preserve uncertainty for owner review.
6. Removing/reinstalling may lose the Profile's local identity. Revoke the old Endpoint
   through authenticated MCP, then pair afresh with a new code. Do not treat the same
   public extension ID as proof of retained pairing or silently restore credentials.

Current slice has T1 pairing/Stop, T2 observation and T3 tab operations. Sensitive grants
and consequential actions remain unavailable. Their final update/rollback/Unknown and
approval acceptance belongs to T9/T10; do not claim those features are verified here.

## API basis and evidence limits

- [TabGroup.shared](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
  is Chrome 137+, used to avoid reusing shared groups; this is the highest current floor.
- [WSS service-worker activity](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
  requires Chrome 116+; the extension sends traffic every 20 seconds.
- [webNavigation documentId](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)
  is Chrome 106+; [storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
  trusted contexts/session APIs require Chrome 102+ and define session reset semantics.
- [Manifest Key](https://developer.chrome.com/docs/extensions/reference/manifest/key)
  documents the stable development installation identifier.

Local mocked tests cover compatible reconnection, retained pairing and Stop, fresh session
identity after Reload, stale command rejection and incompatible handshake refusal.
Real Developer Mode install, replacement/Reload, fallback, uninstall/re-pair and both
browsers' permission UI/WSS remain **Not run**. Offline tests cannot prove them.
