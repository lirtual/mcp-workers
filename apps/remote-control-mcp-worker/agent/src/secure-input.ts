import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AgentSecureInputTarget =
  | { kind: "task_process"; session_id: string; name: string }
  | { kind: "github_repository_secret" | "github_repository_variable"; repository: string; name: string }
  | { kind: "github_environment_secret" | "github_environment_variable"; repository: string; environment: string; name: string }
  | { kind: "cloudflare_worker_secret"; account_id: string; worker_name: string; environment: string; mode: "deploy" | "version"; name: string };

export type AgentSecureInputPrincipal =
  | { provider: "github"; identity: string; repository: string; permission: "admin" }
  | { provider: "cloudflare"; identity: string; account_id: string; account_name?: string };

export type SecureInputOutcome = { status: "succeeded" | "failed" | "unknown"; error_code?: string };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const KEY = /^[A-Z_][A-Z0-9_]{0,99}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ENV = /^[A-Za-z0-9_.-]{1,64}$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const MAX_SECRET_BYTES = 8_192;
const PROVIDER_PREFLIGHT_BUDGET_MS = 3_500;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function parseAgentSecureInputTarget(value: unknown): AgentSecureInputTarget | null {
  if (!object(value) || typeof value.kind !== "string") return null;
  if (value.kind === "task_process") {
    if (!exact(value, ["kind", "session_id", "name"]) || typeof value.session_id !== "string" ||
        !UUID.test(value.session_id) || typeof value.name !== "string" || !KEY.test(value.name)) return null;
    return { kind: value.kind, session_id: value.session_id, name: value.name };
  }
  if (value.kind === "github_repository_secret" || value.kind === "github_repository_variable") {
    if (!exact(value, ["kind", "repository", "name"]) || typeof value.repository !== "string" ||
        !REPO.test(value.repository) || value.repository.includes("..") ||
        typeof value.name !== "string" || !KEY.test(value.name)) return null;
    return { kind: value.kind, repository: value.repository, name: value.name };
  }
  if (value.kind === "github_environment_secret" || value.kind === "github_environment_variable") {
    if (!exact(value, ["kind", "repository", "environment", "name"]) ||
        typeof value.repository !== "string" || !REPO.test(value.repository) || value.repository.includes("..") ||
        typeof value.environment !== "string" || !ENV.test(value.environment) ||
        typeof value.name !== "string" || !KEY.test(value.name)) return null;
    return { kind: value.kind, repository: value.repository, environment: value.environment, name: value.name };
  }
  if (value.kind === "cloudflare_worker_secret") {
    if (!exact(value, ["kind", "account_id", "worker_name", "environment", "mode", "name"]) ||
        typeof value.account_id !== "string" || !ACCOUNT.test(value.account_id) ||
        typeof value.worker_name !== "string" || !WORKER.test(value.worker_name) ||
        typeof value.environment !== "string" || (value.environment !== "default" && !ENV.test(value.environment)) ||
        (value.mode !== "deploy" && value.mode !== "version") ||
        typeof value.name !== "string" || !KEY.test(value.name)) return null;
    return { kind: value.kind, account_id: value.account_id, worker_name: value.worker_name,
      environment: value.environment, mode: value.mode, name: value.name };
  }
  return null;
}

export function validateAgentSecureInputSecret(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_SECRET_BYTES) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value; }
  catch { return false; }
}

type Provider = "github" | "cloudflare";
type CommandResult = { code: number | null; stdout: string; timedOut: boolean; aborted: boolean; spawnError: boolean; inputError: boolean };

function providerEnvironment(provider: Provider, accountId?: string): NodeJS.ProcessEnv {
  const keys = provider === "github"
    ? ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "TMP", "TEMP",
      "XDG_CONFIG_HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR"]
    : ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "TMP", "TEMP",
      "XDG_CONFIG_HOME", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL",
      "WRANGLER_HOME", "NODE_ENV"];
  const env = { CI: "1", WRANGLER_SEND_METRICS: "false" } as unknown as NodeJS.ProcessEnv;
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (provider === "cloudflare" && accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}

function runProviderCommand(
  provider: Provider, program: string, args: string[],
  options: { accountId?: string; input?: string; signal: AbortSignal; timeoutMs: number; captureStdout?: boolean },
): Promise<CommandResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    let directory: string | undefined;
    let stdout = "", timedOut = false, aborted = false, spawnError = false, inputError = false, settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (directory) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* metadata-only temporary directory */ }
      }
      resolve({ code, stdout, timedOut, aborted, spawnError, inputError });
    };
    const terminate = () => {
      if (!child?.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch { /* already exited */ }
      const killTimer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch { /* already exited */ }
      }, 500);
      killTimer.unref?.();
    };
    const abort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    try {
      // Explicit metadata-only configuration avoids project account precedence.
      if (provider === "cloudflare") {
        if (!options.accountId) throw new Error("missing account");
        directory = mkdtempSync(join(realpathSync(tmpdir()), "rca-provider-"));
        const config = join(directory, "wrangler.json");
        writeFileSync(config, JSON.stringify({ account_id: options.accountId }), { flag: "wx", mode: 0o600 });
        args = ["--config", config, ...args];
      }
      child = spawn(program, args, {
        cwd: directory,
        stdio: [options.input === undefined ? "ignore" : "pipe",
          options.captureStdout ? "pipe" : "ignore", "ignore"],
        env: providerEnvironment(provider, options.accountId),
        detached: process.platform !== "win32", windowsHide: true,
      });
    } catch {
      spawnError = true;
      finish(null);
      return;
    }
    child.once("error", () => { spawnError = true; finish(null); });
    child.once("close", code => finish(code));
    if (options.captureStdout) {
      child.stdout?.on("data", chunk => {
        if (stdout.length + chunk.length > 32_768) { terminate(); return; }
        stdout += chunk.toString("utf8");
      });
    }
    if (options.input !== undefined) {
      if (!child.stdin) {
        inputError = true;
        terminate();
      } else {
        child.stdin.once("error", () => { inputError = true; terminate(); });
        try { child.stdin.end(options.input, "utf8"); }
        catch { inputError = true; terminate(); }
      }
    }
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
}

function parseJson(text: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(text); return object(value) ? value : null; }
  catch { return null; }
}

type GitHubTarget = Extract<AgentSecureInputTarget, { kind:
  "github_repository_secret" | "github_repository_variable" |
  "github_environment_secret" | "github_environment_variable" }>;

function principalMatches(expected: unknown, actual: AgentSecureInputPrincipal): boolean {
  if (!object(expected) || expected.provider !== actual.provider || expected.identity !== actual.identity) return false;
  if (actual.provider === "github") return expected.repository === actual.repository && expected.permission === "admin";
  return expected.account_id === actual.account_id && expected.account_name === actual.account_name;
}

function commandFailure(result: CommandResult, phase: "prepare" | "write"): SecureInputOutcome | null {
  if (phase === "write" && result.inputError) return { status: "unknown", error_code: "execution_interrupted" };
  if (result.spawnError) return { status: "failed", error_code: "provider_cli_unavailable" };
  if (result.aborted) return phase === "prepare"
    ? { status: "failed", error_code: "execution_interrupted" }
    : { status: "unknown", error_code: "execution_interrupted" };
  if (result.timedOut) return phase === "prepare"
    ? { status: "failed", error_code: "timed_out" }
    : { status: "unknown", error_code: "timed_out" };
  if (result.code !== 0) return phase === "prepare"
    ? { status: "failed", error_code: "target_not_accessible" }
    : { status: "unknown", error_code: "provider_write_failed" };
  return null;
}

async function prepareGitHub(target: GitHubTarget, signal: AbortSignal, deadline: number): Promise<AgentSecureInputPrincipal | SecureInputOutcome> {
  const userResult = await runProviderCommand("github", "gh", ["api", "user"], {
    signal, timeoutMs: Math.max(1, Math.min(20_000, deadline - Date.now())), captureStdout: true,
  });
  const userFailure = commandFailure(userResult, "prepare");
  if (userFailure) return userFailure;
  const user = parseJson(userResult.stdout);
  if (!user || typeof user.login !== "string" || !user.login) return { status: "failed", error_code: "provider_auth_unavailable" };

  const repoResult = await runProviderCommand("github", "gh", ["api", "repos/" + target.repository], {
    signal, timeoutMs: Math.max(1, Math.min(20_000, deadline - Date.now())), captureStdout: true,
  });
  const repoFailure = commandFailure(repoResult, "prepare");
  if (repoFailure) return repoFailure;
  const repo = parseJson(repoResult.stdout);
  if (!repo || typeof repo.full_name !== "string" ||
      repo.full_name.toLowerCase() !== target.repository.toLowerCase() ||
      !object(repo.permissions) || repo.permissions.admin !== true) {
    return { status: "failed", error_code: "target_not_accessible" };
  }
  if (target.kind === "github_environment_secret" || target.kind === "github_environment_variable") {
    const envResult = await runProviderCommand("github", "gh", [
      "api", "repos/" + target.repository + "/environments/" + encodeURIComponent(target.environment),
    ], { signal, timeoutMs: Math.max(1, Math.min(20_000, deadline - Date.now())), captureStdout: true });
    const envFailure = commandFailure(envResult, "prepare");
    if (envFailure) return envFailure;
    const environment = parseJson(envResult.stdout);
    if (!environment || typeof environment.name !== "string" ||
        environment.name.toLowerCase() !== target.environment.toLowerCase()) {
      return { status: "failed", error_code: "target_not_accessible" };
    }
  }
  return { provider: "github", identity: user.login, repository: target.repository, permission: "admin" };
}

function cloudflareScriptName(worker: string, environment: string): string {
  return environment === "default" ? worker : `${worker}-${environment}`;
}

async function prepareCloudflare(
  target: Extract<AgentSecureInputTarget, { kind: "cloudflare_worker_secret" }>, signal: AbortSignal, deadline: number,
): Promise<AgentSecureInputPrincipal | SecureInputOutcome> {
  const identityResult = await runProviderCommand("cloudflare", "wrangler",
    ["whoami", "--account", target.account_id, "--json"],
    { accountId: target.account_id, signal, timeoutMs: Math.max(1, Math.min(20_000, deadline - Date.now())), captureStdout: true });
  const identityFailure = commandFailure(identityResult, "prepare");
  if (identityFailure) return identityFailure;
  const identityData = parseJson(identityResult.stdout);
  if (!identityData || identityData.loggedIn !== true) return { status: "failed", error_code: "provider_auth_unavailable" };
  const identity = identityData.authType === "Account API Token" ? `account:${target.account_id}` : identityData.email;
  const accounts = Array.isArray(identityData.accounts) ? identityData.accounts : [];
  const account = accounts.find((item: unknown) => object(item) && item.id === target.account_id) as Record<string, unknown> | undefined;
  if (typeof identity !== "string" || !identity || !account) return { status: "failed", error_code: "provider_auth_unavailable" };

  const args = ["deployments", "list", "--name", cloudflareScriptName(target.worker_name, target.environment), "--json"];
  const workerResult = await runProviderCommand("cloudflare", "wrangler", args, {
    accountId: target.account_id, signal, timeoutMs: Math.max(1, Math.min(20_000, deadline - Date.now())), captureStdout: true,
  });
  const workerFailure = commandFailure(workerResult, "prepare");
  if (workerFailure) return workerFailure;
  let deployments: unknown;
  try {
    const parsed: unknown = JSON.parse(workerResult.stdout);
    deployments = Array.isArray(parsed) ? parsed : object(parsed) ? parsed.deployments : undefined;
  } catch { deployments = undefined; }
  if (!Array.isArray(deployments) || deployments.length === 0) return { status: "failed", error_code: "target_not_accessible" };
  return { provider: "cloudflare", identity, account_id: target.account_id,
    ...(typeof account.name === "string" ? { account_name: account.name } : {}) };
}

export async function prepareSecureInputProvider(
  target: AgentSecureInputTarget, signal: AbortSignal,
): Promise<AgentSecureInputPrincipal | SecureInputOutcome | undefined> {
  if (target.kind === "task_process") return undefined;
  if (signal.aborted) return { status: "failed", error_code: "execution_interrupted" };
  const deadline = Date.now() + PROVIDER_PREFLIGHT_BUDGET_MS;
  if (target.kind === "github_repository_secret" || target.kind === "github_repository_variable" ||
      target.kind === "github_environment_secret" || target.kind === "github_environment_variable") {
    return prepareGitHub(target, signal, deadline);
  }
  return prepareCloudflare(target as Extract<AgentSecureInputTarget, { kind: "cloudflare_worker_secret" }>, signal, deadline);
}

export async function executeSecureInputProvider(
  target: Exclude<AgentSecureInputTarget, { kind: "task_process" }>,
  expectedPrincipal: unknown, secret: string, signal: AbortSignal,
): Promise<SecureInputOutcome> {
  // Reject only the suffixes that the selected native CLI would silently strip.
  const lossyProviderInput = target.kind === "cloudflare_worker_secret"
    ? secret.trimEnd() !== secret
    : secret.endsWith("\r") || secret.endsWith("\n");
  if (!validateAgentSecureInputSecret(secret) || lossyProviderInput) {
    return { status: "failed", error_code: "input_rejected" };
  }
  const current = await prepareSecureInputProvider(target, signal);
  if (!current || "status" in current || !principalMatches(expectedPrincipal, current)) {
    return { status: "failed", error_code: "target_not_accessible" };
  }
  if (signal.aborted) return { status: "unknown", error_code: "execution_interrupted" };
  let program: string, args: string[], provider: Provider;
  if (target.kind === "github_repository_secret" || target.kind === "github_environment_secret" ||
      target.kind === "github_repository_variable" || target.kind === "github_environment_variable") {
    provider = "github";
    const variable = target.kind.endsWith("_variable");
    args = [variable ? "variable" : "secret", "set", target.name, "--repo", target.repository];
    if (target.kind === "github_environment_secret" || target.kind === "github_environment_variable") args.push("--env", target.environment);
    program = "gh";
  } else {
    const cloudflare = target as Extract<AgentSecureInputTarget, { kind: "cloudflare_worker_secret" }>;
    provider = "cloudflare";
    const script = cloudflareScriptName(cloudflare.worker_name, cloudflare.environment);
    args = cloudflare.mode === "deploy"
      ? ["secret", "put", cloudflare.name, "--name", script]
      : ["versions", "secret", "put", cloudflare.name, "--name", script];
    program = "wrangler";
  }
  const result = await runProviderCommand(provider, program, args, {
    accountId: target.kind === "cloudflare_worker_secret"
      ? (target as Extract<AgentSecureInputTarget, { kind: "cloudflare_worker_secret" }>).account_id : undefined,
    input: secret, signal, timeoutMs: 60_000,
  });
  return commandFailure(result, "write") ?? { status: "succeeded" };
}
