import { clerkOwnerConfigured, clerkOwnerOrigin, verifyClerkOwner, type ClerkOwnerConfig } from "./clerk-owner-session.ts";
import { validateSecureInputSecret } from "./v2-secure-input.ts";

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_BODY = 65_536;
const CLERK_ORIGIN = "https://clerk.lirtual.dpdns.org";
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
const publishableKey = ${JSON.stringify(config.CLERK_PUBLISHABLE_KEY ?? "")};
const form = document.getElementById("secure-form"), field = document.getElementById("secret");
const submit = document.getElementById("submit"), status = document.getElementById("status");
let ownerToken = null;
function text(id, value) { document.getElementById(id).textContent = value == null ? "—" : String(value); }
function showState(value) {
  text("state", value.state);
  const pending = value.state === "pending";
  form.hidden = !pending; submit.disabled = !pending;
  if (value.state === "unknown") status.textContent = "Outcome uncertain. Do not submit again; check the original ChatGPT request.";
  if (value.state === "succeeded") status.textContent = "The target Agent confirmed completion.";
  if (value.state === "failed") status.textContent = "The target Agent reported failure. Do not reuse this request.";
  if (value.state === "cancelled" || value.state === "expired") status.textContent = "This request can no longer accept input.";
}
async function details() {
  const response = await fetch("/secure-input/" + requestId + "/details", {
    method: "POST", cache: "no-store",
    headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" }, body: "{}"
  });
  if (!response.ok) throw new Error("Request unavailable or not authorized.");
  return await response.json();
}
async function refresh() {
  const value = await details();
  text("purpose", value.purpose); text("target", JSON.stringify(value.target));
  text("execution", JSON.stringify(value.execution));
  text("principal", value.provider_principal ? JSON.stringify(value.provider_principal) : "Not applicable");
  text("expires", new Date(value.expires_at).toLocaleString()); showState(value);
}
document.getElementById("signin").href =
  "https://accounts.lirtual.dpdns.org/sign-in?redirect_url=" + encodeURIComponent(location.href);
(async () => {
  try {
    if (!window.Clerk) throw new Error("Owner sign-in unavailable.");
    await window.Clerk.load({ publishableKey });
    ownerToken = window.Clerk.session ? await window.Clerk.session.getToken() : null;
    if (!ownerToken) { document.getElementById("signin-panel").hidden = false; return; }
    await refresh(); document.getElementById("details").hidden = false;
  } catch { status.textContent = "Owner verification failed. No input was sent."; }
})();
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (submit.disabled || !ownerToken) return;
  const value = field.value;
  if (!value.trim()) { status.textContent = "Enter a non-empty value."; return; }
  field.value = ""; submit.disabled = true; status.textContent = "Submitting once. Do not submit again.";
  try {
    const response = await fetch("/secure-input/" + requestId + "/submit", {
      method: "POST", cache: "no-store",
      headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ secret: value })
    });
    const result = await response.json();
    if (!response.ok) { status.textContent = "Input not accepted or request already consumed. Do not retry."; return; }
    showState(result); status.textContent = "Input submitted once. Waiting for the target Agent."; await refresh();
  } catch { status.textContent = "Response lost; outcome may be unknown. Do not retry."; }
});
document.getElementById("refresh").addEventListener("click", async () => {
  try { await refresh(); } catch { status.textContent = "Status is temporarily unavailable."; }
});
  `;
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>RCA Secure Input</title>
<style nonce="${token}">
body{font:16px system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 18px;color:#17202a}
section{border:1px solid #ccd3da;border-radius:12px;padding:18px;margin:16px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:10px;border-radius:8px}
textarea{box-sizing:border-box;width:100%;min-height:110px;font:14px ui-monospace,monospace;-webkit-text-security:disc}
button,a{font:inherit;padding:9px 14px}button{cursor:pointer}
.warning{color:#8a3100;font-weight:600}
</style></head><body>
<h1>RCA Secure Input</h1>
<p>This link is not authorization. Sign in with the configured Clerk Owner account before viewing or submitting.</p>
<section id="signin-panel" hidden><p>Owner sign-in required.</p><a id="signin">Sign in</a></section>
<section id="details" hidden>
<h2>Review the exact target</h2>
<p><strong>Purpose</strong></p><pre id="purpose"></pre>
<p><strong>Target resource and operation</strong></p><pre id="target"></pre>
<p><strong>Execution location</strong></p><pre id="execution"></pre>
<p><strong>Provider principal</strong></p><pre id="principal"></pre>
<p><strong>Expires</strong> <span id="expires"></span></p>
<p><strong>Request state</strong> <span id="state">loading</span></p>
<form id="secure-form" hidden>
<label for="secret">Credential value</label>
<textarea id="secret" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>
<p class="warning">Submitted once to the bound Agent. Never paste this value into ChatGPT.</p>
<button id="submit" type="submit">Submit once</button>
</form>
<button id="refresh" type="button">Refresh status</button>
<p id="status" role="status" aria-live="polite"></p>
</section>
<script src="${CLERK_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>
<script nonce="${token}">${script}</script>
</body></html>`;
  const csp = [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "script-src 'self' 'nonce-" + token + "' " + CLERK_ORIGIN,
    "connect-src 'self' " + CLERK_ORIGIN, "style-src 'self' 'nonce-" + token + "'",
    "img-src 'self' data:", "font-src 'self'", "frame-src " + CLERK_ORIGIN,
  ].join("; ");
  return new Response(body, { headers: { ...headers, "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp } });
}

export function isSecureInputPath(pathname: string): boolean {
  return /^\/secure-input\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/(?:details|submit))?$/.test(pathname);
}

export async function handleSecureInput(
  request: Request, config: ClerkOwnerConfig & { CLERK_OWNER_USER_ID?: string }, owner: DurableObjectStub,
): Promise<Response> {
  const match = /^\/secure-input\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(details|submit))?$/.exec(new URL(request.url).pathname);
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
  if (request.headers.get("origin") !== clerkOwnerOrigin) return json({ error: "invalid_origin" }, 403);
  if (!await verifyClerkOwner(request, config)) return json({ error: "unauthorized" }, 401);
  const ownerUserId = config.CLERK_OWNER_USER_ID!;
  let body: unknown;
  try { body = await boundedJson(request); } catch { return json({ error: "bad_request" }, 400); }
  if (!isObject(body)) return json({ error: "bad_request" }, 400);
  if (action === "details") {
    if (!exact(body, [])) return json({ error: "bad_request" }, 400);
    try {
      const response = await owner.fetch("https://v2.internal/secure-input/status", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_user_id: ownerUserId, request_id: requestId }),
      });
      const result = await response.json() as object;
      return json(result, response.status);
    } catch { return json({ error: "unavailable" }, 503); }
  }
  if (!exact(body, ["secret"]) || !validateSecureInputSecret(body.secret)) {
    return json({ error: "bad_request" }, 400);
  }
  let secret = body.secret;
  try {
    const response = await owner.fetch("https://v2.internal/secure-input/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner_user_id: ownerUserId, request_id: requestId, secret }),
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
