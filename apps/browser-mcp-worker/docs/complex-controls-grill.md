# Browser MCP — modern web-control compatibility design (Grill With Docs consensus)

Status: **Owner consensus reached: Q1=A, Q2=A, Q3=A (2026-10-31); design only**. No implementation, deploy, merge, or new Browser extension permissions authorized. This note is an incremental Browser MCP interaction investigation, separate from idle lifetime/UI Spec #626 and completed #418/#531.

## User problem and observed evidence

On 2026-10-31 the owner reported that Browser MCP could not select options on the **Tailscale credential-creation** page; a manual workaround was used for that browser task. Historical conversation confirms the control was described as a dropdown, but does **not** retain the exact failed request/receipt or establish whether it was a native `select` or a custom combobox. Do not treat one hypothesis as reproduced root cause, and do not execute a credential-creation task to troubleshoot the UI.

Owner compares Browser MCP to a Codex/Browser extension that shows a visible mouse pointer. Cursor visualization and actual trusted pointer/keyboard input must be distinguished; displaying a synthetic cursor alone does not fix a component that expects native input.

## Current implementation facts (main at 4d75bfc, 2026-10-31)

- The fixed public MCP interaction contract consists of `click`, `fill`, `keypress`, `scroll`, `select` on an explicit Endpoint/tab/document/element reference. User-provided JavaScript, coordinates, arbitrary CSS selectors and CDP commands are not exposed.
- Snapshot action nodes come from top-document `input,textarea,select,button,a,summary,[role=button],[role=menuitem],[tabindex]` candidates. It does **not** explicitly discover `role=combobox`, `role=option`, `role=listbox`, `aria-expanded`, `aria-selected`, or the actual native `select.options[]` labels/values. It caps scanning at 500 candidates / 100 returned elements.
- `select` rejects everything except a *single* native `HTMLSelectElement` with a present, enabled option whose raw value exactly matches the caller's input. It assigns the DOM value and dispatches synthetic `input` and `change`; it does not confirm the application accepted it.
- `click` uses `HTMLElement.click()`, not real pointer move/down/up. `keypress` dispatches synthetic keydown/keyup on ordinary text-like input/textarea only and allows Arrow keys, Home, End and Escape; Enter, Space, Tab and native text-editing defaults are not implemented.
- Interaction only targets the top document in the isolated extension world, with an observed document ID and a short-lived opaque element ID. It deliberately excludes cross-origin frames and credential/OTP surfaces.
- An operation receipt `completed` means the action was dispatched according to the browser extension. It is **not** website state verification or business success; Unknown cannot be blindly retried with a new key. These semantics must be kept.
- Existing `interactions.test.mjs` uses a native `select` fixture with `value=blue`, not a real custom popover/combobox; passing tests would not establish Tailscale parity.

## Proposed minimum working slice (confirmed by Owner)

1. **Observe**: expose bounded accessible role/name, expanded/selected/disabled state, native Select option `label/value`, and discover visible `combobox/listbox/option/menuitem` controls. Preserve document and element identities, sensitivity controls, bounded sizes, and the current no-leak model. For custom popovers, after opening, take a *fresh* snapshot of the newly rendered options.
2. **Act**: select from a fresh, explicitly resolved option or navigate with carefully constrained supported keys. Do not invent option values or click arbitrary coordinates. Keep the existing per-Endpoint intent/receipt protocol. Fail as unsupported when the framework requires trusted input the extension cannot safely synthesize.
3. **Verify**: offer read-only post-action observation of native `selectedOptions` or actual ARIA `selected/expanded` states, with honest `verified/unverified` interpretation. Do not silently redefine persisted `completed` into business-success; do not automatically re-execute side effects after an ambiguous receipt.
4. **Visual feedback**: if chosen, show a short-lived, non-interactive target marker/cursor overlay only on the explicitly selected eligible tab, with no automated tab focus switch and no claim it represents an OS cursor or creates trusted pointer events.
5. **Scope**: preserve the current top-document boundary, Owner Access/Unknown-review exclusion, explicit element binding and local ON/OFF. No new Worker/DO/KV/D1, automation platform, blanket Playwright/CDP exposure, or second CI.

## Permission/technical alternative

Chrome's `chrome.debugger` extension permission exposes the powerful Chrome DevTools Protocol Input and other domains. It can provide native-level input semantics but has a broad warning and can bypass some ordinary webpage restrictions. Official Chromium references:
- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/security_faq.md
- https://chromedevtools.github.io/devtools-protocol/tot/Input/

Default proposal: **do not add debugger now**. First implement/validate the smallest semantic fixed-tool path and collect real evidence of any unhandled trusted-input-only component. If later proven necessary, return for a separately authorized security/permission design; never expose arbitrary CDP or page-JS tools.

W3C WAI-ARIA combobox/listbox references:
- https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
- https://www.w3.org/WAI/ARIA/apg/patterns/listbox/

## Existing testing seams, not a new CI

1. Existing Worker/DO and extension VM tests for a native select (`label/value`), an ARIA select-only combobox, listbox options dynamically mounted after opening, disabled/duplicate options, keyboard focus and input state.
2. Existing document/element binding tests for navigation, re-render and stale observation, including a late callback/Stop, sensitive target, isolated Profile and Unknown receipt preservation.
3. Real installed Chrome **and** Edge version-matched native controlled test webpage: open -> fresh snapshot -> choose option -> new snapshot confirms the selected value/state; verify a site with keyboard-only selection where relevant.
4. The historic Tailscale failure needs controlled **read-only** reproduction/recording of actual semantics before claiming the root cause is fixed. Never create or rotate real credentials solely for testing.
5. Maintain separation between CI, Chrome/Edge native tests, extension ZIP release, Worker deployment, and production outcome.

## Round 1 — decisions now confirmed

- **Q1**: Keep the current permission set and improve semantic interactions first, deferring any `chrome.debugger` and trusted mouse/keyboard input until a demonstrated blocking case? **Confirmed A**.
- **Q2**: Limit initial compatibility to native select + accessible custom combobox/listbox/menu + essential keyboard/focus and readback; defer broad drag-and-drop, canvas, closed Shadow DOM and cross-origin iframe? **Confirmed A**.
- **Q3**: Add a short-lived, optional visible action-target marker in an already-selected eligible tab, without moving the OS pointer or stealing window focus? **Confirmed A**.

Confirmed decisions and final contracts follow below. Record a separate Spec through the existing issue process; do not modify #626.

## 2026-10-31 Owner consensus — Q1=A, Q2=A, Q3=A

The Owner explicitly accepted the recommendations after reviewing the comparison with the Codex/ChatGPT Browser products. These are **confirmed product decisions**, not a claim that our runtime implements the improvements or that Codex exposes a particular internal protocol.

- **Q1=A**: First improve the existing fixed DOM/ARIA tool contract with the current Chrome/Edge permission set. Do **not** add `chrome.debugger`, arbitrary CDP, broad page-script execution or OS Computer Use. If controlled live evidence proves a common component cannot be operated without trusted browser input, propose a separate scoped-permission design and obtain approval before adding that capability.
- **Q2=A**: The *initial acceptance slice* is native `select`, accessible custom combobox/listbox/menu, bounded keyboard/focus capabilities and read-only post-action state verification. This is **not** a permanent product ceiling; drag-and-drop, richer hover, canvas and complicated frames are considered only when task evidence justifies them.
- **Q3=A**: Optional, transient, non-interactive visual target feedback (brief marker/highlight/pseudo-cursor) on the explicitly authorized tab only. This is **not** a real OS pointer or a substitute for pointer input and must not force tab/window focus.

### Final contract details and explicit negative boundaries

**Observation.** Extend only the existing `browser_snapshot` to return bounded, truthful interaction descriptors: stable opaque element ID, semantic role where available, short accessible name/visible label, disabled/expanded/selected/checked/focusable state when directly observable, and for a native single-choice `select`, available non-sensitive option label/value pairs and current selected option. Custom options appearing after opening a menu require a fresh snapshot. An option is selectable only if it is currently visible and enabled. Do not infer values from text; do not silently select the first similarly named item.

Retain the existing top-document and authorized Chrome/Edge Profile boundary, the current size ceilings, current document identity and short-lived element-ref rules, private/LAN local grants and protection for credential/OTP inputs and Owner activation/Unknown-review pages. Keep read exclusion of text-input values, and do not expose sensitive option values: allowlist attributes, inspect field identity and refuse/omit when uncertain. Avoid broad DOM serialization or arbitrary selector enumeration. Closed Shadow DOM, cross-origin frames, canvas-based controls and inaccessible custom components are explicitly unsupported in this slice, with honest error reasons. No changes to the browser's page focus merely to take a snapshot.

**Mutations.** Keep `browser_select` for native select with an explicit observed option value; the implementation must recheck that the option is still present and enabled at execute time. For ARIA custom controls, use the existing fixed element-bound `browser_click` action to open, take a new snapshot, and click the explicit option. Extend only the necessary fixed focus/key actions in the common contract, without exposing arbitrary scripts, selectors, coordinates, raw CDP methods or browser-wide focus. A synthetic `KeyboardEvent` cannot reproduce trusted native Tab/Enter defaults on every site; do not report these as generally supported unless actual end-to-end behavior is established. When a component requires trusted pointer/keyboard input, return a distinct `unsupported_input`/equivalent rejection **before sending a potentially irreversible action** when this can be determined; if dispatch may have happened, retain the original terminal receipt/Unknown semantics.

**Readback.** The existing durable receipt `completed` must still mean browser action dispatch, not necessarily selection accepted by the target app or website business success. A fresh explicit `browser_snapshot` after each observed action can confirm the exact option/ARIA state; distinguish an observed selected state from an unverifiable or stale page and from any resulting external business effect. Do not automatically rerun a completed or Unknown write with a fresh intent key when verification fails. A changed page can invalidate refs, so capture a new document/element target instead of falling back to guessed coordinates. Initial verification should be **read-only**, with no new server-side business outcome store or second durable receipt schema.

**Visual feedback.** An optional ephemeral overlay is purely illustrative and must not intercept input (`pointer-events:none`), persist page content, become a remote execution target, alter accessibility/selection state, or change tab focus. Use fixed, small styles, remove it on stop/revoke/navigation or after a short bounded interval, and suppress it for sensitive/protected surfaces. Never claim it means an input was trusted or completed; the action and readback results remain the source of truth. A screenshot may include an overlay, so either exclude it from capture or label the output appropriately without leaking more page data.

**Tool/API minimization.** Prefer enriching existing snapshot/action results and the narrowest possible extension of the five interaction actions over adding many public tools. The first slice does not change `browser_endpoints`, Owner activation, WSS routing, local ON/OFF, User Task Authorization or Endpoint identity. Shared consent and intent/Unknown protections continue on every mutation. Any new action/property requires extension/Worker/schema/tool discovery/version compatibility together; do not silently accept newer messages from older clients.

### Focused acceptance checklist — required evidence, not exhaustive historical replay

1. **Native select**: discovery returns correctly bounded, non-sensitive option labels/values; selecting by observed value produces actual changed value in a fresh snapshot. Disabled and duplicate-value/duplicate-label options fail closed rather than guessing.
2. **ARIA combobox/listbox/menu**: on a controlled React/Radix-like fixture, the opener and later-mounted `role=option` or `menuitem` are discoverable *after opening*. A fresh option click is delivered and the selected/expanded state is observable. Include a failed synthetic-input case and report `unsupported` when not solvable without trusted input.
3. **Keyboard and focus**: exercise only supported keys/target types and prove their actual native/DOM effects; simulated events without browser default actions are not counted as working Tab/Enter navigation. Do not regress input/credential restrictions.
4. **Freshness, safety and receipts**: stale refs, changed document, Stop/Revoke race, disabled options and hidden/protected elements cannot be acted on; original intent keys/Unknown remain queryable and no write is blindly retried.
5. **UI overlay**: marker appears only in the selected eligible tab, does not steal focus, blocks no input, and is removed/disabled on Stop or timeout; accessibility and screenshot protections stay intact.
6. **Real Chrome and Edge**: use the existing version-matched unpacked extension and current Worker contract on a benign controlled HTML/ARIA demo page. Record both action receipt and *independent* state readback. Source/unit/CI success alone is not real client acceptance. Do not create real Tailscale credentials or claim to have reproduced that exact dropdown without evidence.
7. **Release boundary**: verify unchanged non-browser behaviors only where directly affected; keep released extension ZIP compatibility and release evidence separate. A production Worker deploy/extension install requires separate owner authorization.

### Design closure and complexity review

No remaining independent product decisions are necessary for this first slice. The essential security tradeoff was Q1 (defer broader debugger permissions) and is already recorded here; do **not** add another ADR merely to mirror the design. Existing Browser MCP ADR 0001 (extension/WSS/Cloudflare) and ADR 0002 (Profile Grant vs User Task Authorization) remain in force. No new worker, database, queue, CI pipeline, Browser MCP tool family or acceptance environment is justified. Discovered future incompatibility with trusted-input-only components should be reported as **unsupported/pending permission decision**, not silently expanded into CDP.

**State:** design and first-slice acceptance criteria agreed; code implementation, Chrome/Edge acceptance, PR merge, and production release **Not performed**. Ready to convert to an independent Spec without reopening completed #418/#531 or expanding #626.
