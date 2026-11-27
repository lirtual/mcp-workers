import { clerkIssuer, clerkBrowserSdk, clerkOwnerSignInUrl, clerkOwnerConfigured, clerkOwnerOrigin, verifyClerkOwner, type ClerkOwnerConfig } from "./clerk-owner-session.ts";
import { validateSecureInputSecret } from "./secure-input.ts";

const ROUTE = /^\/secure-input\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(details|submit|cancel))?$/;
const MAX_BODY = 65_536;
const headers = {
  "cache-control": "no-store, max-age=0", "pragma": "no-cache",
  "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  "x-frame-options": "DENY", "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const json = (body: object, status = 200) => Response.json(body, { status, headers });
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function boundedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY) throw new Error("oversize");
  if (!request.body) throw new Error("missing");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error("oversize");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function page(requestId: string, config: ClerkOwnerConfig): Response {
  const token = nonce();
  const script = `
const requestId = ${JSON.stringify(requestId)};
const form = document.getElementById("secure-form"), field = document.getElementById("secret");
const submit = document.getElementById("submit"), status = document.getElementById("status");
const cancel = document.getElementById("cancel");
let busy = false, inputAttempted = false, reviewed = null;
function text(id, value) { document.getElementById(id).textContent = value == null ? "—" : String(value); }
function describeTarget(target) {
  if (target.kind === "task_process") return "Process input · " + target.name;
  if (target.kind.startsWith("github_")) {
    return "GitHub " + (target.kind.endsWith("_variable") ? "Variable" : "Secret") + " · " +
      target.repository + (target.environment ? " / " + target.environment : "") + " / " + target.name;
  }
  if (target.kind === "cloudflare_worker_secret") {
    return "Cloudflare Secret · " + target.worker_name + " / " + target.environment + " / " + target.name +
      (target.mode === "deploy" ? " (deploy now)" : " (inactive version)");
  }
  return "Unsupported target";
}
function effectAndRecovery(target) {
  if (target.kind === "task_process") return "Deliver once to a trusted process. All captured output for its session is permanently suppressed; delivery cannot be recalled.";
  if (target.kind.startsWith("github_")) return target.kind.endsWith("_variable")
    ? "Set or replace the Variable. Restore its prior value or remove it to recover."
    : "Set or replace the Secret. The prior value cannot be read back; recover by replacing or removing it.";
  if (target.kind === "cloudflare_worker_secret") return target.mode === "deploy"
    ? "Set or replace the Secret and deploy immediately. The prior value cannot be read back; recovery requires replacing it and, if needed, separately deploying a known-good version."
    : "Set or replace the Secret in an inactive version. The prior value cannot be read back; replace it to recover. Deployment requires a separate action.";
  return "Unsupported target.";
}
function showState(value) {
  if (reviewed) reviewed.state = value.state;
  text("error-code", value.error_code || "");
  document.getElementById("error-code").hidden = !value.error_code;
  const pending = value.state === "pending";
  form.hidden = !pending;
  submit.disabled = !pending || busy || inputAttempted;
  cancel.disabled = !pending || busy;
  document.getElementById("refresh").hidden = !inputAttempted && pending;
  if (["succeeded", "failed", "cancelled", "expired"].includes(value.state)) document.getElementById("refresh").hidden = true;
  if (pending && !inputAttempted) status.textContent = "Review the exact target before submitting.";
  if (value.state === "accepted" || value.state === "running") status.textContent = "Input submitted once. Waiting for the target Agent.";
  if (value.state === "unknown") status.textContent = "Outcome uncertain. Do not submit again; check the original ChatGPT request.";
  if (value.state === "succeeded") status.textContent = "The target Agent confirmed completion.";
  if (value.state === "failed") status.textContent = "The target Agent reported failure. Do not reuse this request.";
  if (value.state === "cancelled" || value.state === "expired") status.textContent = "This request can no longer accept input.";
}
async function ownerPost(action, body) {
  // Clerk Session JWTs are short-lived; request the current token on each action.
  const ownerToken = window.Clerk.session ? await window.Clerk.session.getToken() : null;
  if (!ownerToken) throw new Error("Owner sign-in unavailable.");
  return fetch("/secure-input/" + requestId + "/" + action, {
    method: "POST", cache: "no-store", credentials: "omit", redirect: "manual",
    headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
async function details() {
  const response = await ownerPost("details", {});
  if (!response.ok) throw new Error("Request unavailable or not authorized.");
  return await response.json();
}
async function refresh() {
  const value = await details();
  reviewed = value;
  text("purpose", value.purpose);
  text("target", describeTarget(value.target));
  const execution = value.execution;
  const device = value.device_name || execution.device_id;
  text("execution", device + (execution.session_run_id ? " · Run " + execution.session_run_id + " / Attempt " + execution.session_run_attempt : ""));
  const principal = value.provider_principal;
  document.getElementById("principal-row").hidden = !principal;
  text("principal", principal ? principal.identity + (principal.account_name ? " · " + principal.account_name : "") : "");
  text("effect", effectAndRecovery(value.target));
  text("scope", value.is_production ? "Production" : "Marked non-production by requester; verify the resource");
  document.getElementById("production-authorization").hidden = !value.is_production;
  text("exact-target", [
    "Device ID: " + execution.device_id,
    ...(value.target.session_id ? ["Process session: " + value.target.session_id] : []),
    ...(execution.session_attempt_id ? ["Workflow attempt ID: " + execution.session_attempt_id] : []),
    ...(value.target.account_id ? ["Cloudflare account ID: " + value.target.account_id] : []),
    "Grant: " + execution.grant_type,
  ].join("\\n"));
  text("expires", new Date(value.expires_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}));
  showState(value);
}
(async () => {
  try {
    if (!window.Clerk) throw new Error("Owner sign-in unavailable.");
    await window.Clerk.load();
    if (!window.Clerk.isSignedIn || !window.Clerk.session) {
      status.textContent = "Sign in with Clerk to review this request.";
      return;
    }
    await refresh();
    document.getElementById("signin-panel").hidden = true;
    document.getElementById("details").hidden = false;
  } catch {
    status.textContent = "Owner verification failed or sign-in unavailable. No input was sent. Sign in with the configured Owner account or reopen this page.";
  }
})();
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (submit.disabled || busy || inputAttempted || !reviewed || reviewed.state !== "pending") return;
  const value = field.value;
  if (!value.trim()) { status.textContent = "Enter a non-empty value."; return; }
  const productionAuthorized = reviewed.is_production && document.getElementById("production-authorized").checked;
  if (reviewed.is_production && !productionAuthorized) {
    status.textContent = "Authorize the production operation before submitting."; return;
  }
  field.value = ""; busy = true; inputAttempted = true;
  submit.disabled = true; cancel.disabled = true;
  document.getElementById("refresh").hidden = false;
  status.textContent = "Submitting…";
  try {
    const response = await ownerPost("submit", { secret: value, target_confirmed: true, production_authorized: productionAuthorized });
    const result = await response.json();
    if (!response.ok) { status.textContent = "Input not accepted or request already consumed. Do not retry."; return; }
    showState(result);
  } catch { status.textContent = "Response lost; outcome may be unknown. Do not retry."; }
  finally { busy = false; }
});
cancel.addEventListener("click", async () => {
  if (cancel.disabled || busy) return;
  field.value = ""; busy = true; inputAttempted = true;
  submit.disabled = true; cancel.disabled = true;
  document.getElementById("refresh").hidden = false;
  try {
    const response = await ownerPost("cancel", {});
    if (!response.ok) { status.textContent = "Cancellation not confirmed. Check the original request."; return; }
    showState(await response.json());
  } catch { status.textContent = "Cancellation not confirmed. Check the original request."; }
  finally { busy = false; }
});
document.getElementById("refresh").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  try { await refresh(); } catch { status.textContent = "Status is temporarily unavailable."; }
  finally { busy = false; }
  // Re-enable only controls permitted by the latest known state.
  if (reviewed?.state === "pending") {
    submit.disabled = inputAttempted; cancel.disabled = false;
  }
});
  `;
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>RCA Secure Input</title>
<style nonce="${token}">
body{font:16px system-ui,sans-serif;max-width:460px;margin:36px auto;padding:0 20px;color:#17202a}
h1{font-size:1.6rem;margin:0 0 8px}h2{font-size:1.15rem;margin:0 0 16px;overflow-wrap:anywhere}
section{border:1px solid #d6dbe0;border-radius:12px;padding:20px;margin:18px 0}
[hidden]{display:none!important}
dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:0 0 14px}
dt,small,summary{color:#58636f;font-size:.875rem}dd{margin:0;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem}
textarea{box-sizing:border-box;width:100%;min-height:76px;font:16px system-ui,sans-serif;-webkit-text-security:disc;border:1px solid #aeb8c3;border-radius:8px;padding:10px;margin:8px 0}
button,a{font:inherit;padding:10px 14px}button{cursor:pointer;border:1px solid #aeb8c3;border-radius:8px;background:white}
button[type=submit]{background:#17202a;color:white;border:0;width:100%;margin:12px 0}
button:disabled{opacity:.5}#cancel,#refresh{border:0;background:transparent}
.warning{color:#8a3100;font-size:.875rem}
#effect,#status{font-size:.9rem}
</style></head><body>
<h1>RCA Secure Input</h1>
<section id="signin-panel"><p>Sign in to continue.</p><a id="signin" href="${clerkOwnerSignInUrl("/secure-input/" + requestId)}">Sign in with Clerk</a></section>
<p id="status" role="status" aria-live="polite">Checking Owner session…</p>
<section id="details" hidden>
<h2 id="purpose"></h2>
<dl><dt>Target</dt><dd id="target"></dd><dt>Device</dt><dd id="execution"></dd></dl>
<p id="principal-row" hidden><small>Account: </small><span id="principal"></span></p>
<details><summary>Exact target details</summary><pre id="exact-target"></pre></details>
<p id="effect"></p>
<small><span id="scope"></span> · Expires at <span id="expires"></span></small>
<form id="secure-form" hidden>
<label for="secret">Value</label>
<textarea id="secret" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>
<div id="production-authorization" hidden><label class="warning"><input id="production-authorized" type="checkbox"> I authorize this production operation.</label></div>
<button id="submit" type="submit" disabled>Confirm &amp; submit</button>
<button id="cancel" type="button">Cancel</button>
</form>
<p id="error-code" hidden></p>
<button id="refresh" type="button" hidden>Check status</button>
</section>
<script src="${clerkBrowserSdk}" crossorigin="anonymous" data-clerk-publishable-key="${config.CLERK_PUBLISHABLE_KEY}"></script>
<script nonce="${token}">${script}</script>
</body></html>`;
  const csp = [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "script-src 'self' 'nonce-" + token + "' " + clerkIssuer,
    "connect-src 'self' " + clerkIssuer, "style-src 'self' 'nonce-" + token + "'",
    "img-src 'self' data:", "font-src 'self'", "frame-src " + clerkIssuer,
  ].join("; ");
  return new Response(body, { headers: { ...headers, "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp } });
}

export function isSecureInputPath(pathname: string): boolean {
  return ROUTE.test(pathname);
}

export async function handleSecureInput(
  request: Request, config: ClerkOwnerConfig & { CLERK_OWNER_USER_ID?: string }, owner: DurableObjectStub,
): Promise<Response> {
  const match = ROUTE.exec(new URL(request.url).pathname);
  if (!match || !clerkOwnerConfigured(config) || !config.CLERK_OWNER_USER_ID) {
    return new Response("Not found", { status: 404, headers });
  }
  const requestId = match[1]!, action = match[2];
  if (!action) {
    if (request.method !== "GET" || new URL(request.url).origin !== clerkOwnerOrigin) {
      return new Response("Not found", { status: 404, headers });
    }
    return page(requestId, config);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (new URL(request.url).origin !== clerkOwnerOrigin || request.headers.get("origin") !== clerkOwnerOrigin) return json({ error: "invalid_origin" }, 403);
  if (!await verifyClerkOwner(request, config)) return json({ error: "unauthorized" }, 401);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    return json({ error: "unsupported_media_type" }, 415);
  const ownerUserId = config.CLERK_OWNER_USER_ID!;
  let body: unknown;
  try { body = await boundedJson(request); } catch { return json({ error: "bad_request" }, 400); }
  if (!isObject(body)) return json({ error: "bad_request" }, 400);
  if (action === "details" || action === "cancel") {
    if (!exact(body, [])) return json({ error: "bad_request" }, 400);
    try {
      const response = await owner.fetch("https://device.internal/secure-input/" + (action === "details" ? "status" : "cancel"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_user_id: ownerUserId, request_id: requestId }),
      });
      const result = await response.json() as object;
      return json(result, response.status);
    } catch { return json({ error: "unavailable" }, 503); }
  }
  if (!exact(body, ["secret", "target_confirmed", "production_authorized"]) ||
      body.target_confirmed !== true || typeof body.production_authorized !== "boolean" ||
      !validateSecureInputSecret(body.secret)) {
    return json({ error: "bad_request" }, 400);
  }
  let secret = body.secret;
  try {
    const response = await owner.fetch("https://device.internal/secure-input/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner_user_id: ownerUserId, request_id: requestId, secret,
        target_confirmed: body.target_confirmed, production_authorized: body.production_authorized }),
    });
    secret = "";
    body.secret = "";
    return json(await response.json() as object, response.status);
  } catch {
    secret = "";
    body.secret = "";
    return json({ request_id: requestId, state: "unknown", error_code: "execution_interrupted" }, 503);
  }
}
