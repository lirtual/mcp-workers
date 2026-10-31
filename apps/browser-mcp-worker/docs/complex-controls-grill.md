# Browser MCP — complex control compatibility: Grill With Docs (round 1)

Status: **Design investigation only. Decisions Q1–Q3 pending Owner confirmation**. No implementation, deploy, merge, or new Browser extension permissions authorized. This note is an incremental Browser MCP interaction investigation, separate from idle lifetime/UI Spec #626 and completed #418/#531.

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

## Proposed minimum working slice (subject to Q1–Q3)

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

## Design frontier — Owner decision required

- **Q1**: Keep the current permission set and improve semantic interactions first, deferring any `chrome.debugger` and trusted mouse/keyboard input until a demonstrated blocking case? Recommended **A=yes**.
- **Q2**: Limit initial compatibility to native select + accessible custom combobox/listbox/menu + essential keyboard/focus and readback; defer broad drag-and-drop, canvas, closed Shadow DOM and cross-origin iframe? Recommended **A=yes**.
- **Q3**: Add a short-lived, optional visible action-target marker in an already-selected eligible tab, without moving the OS pointer or stealing window focus? Recommended **A=yes**.

After these are confirmed, finish the precise interaction and response contract, update Context and only create an ADR if a hard-to-reverse, surprising tradeoff remains. Publish a **separate** Spec through the existing GitHub issue process; do not modify #626.
