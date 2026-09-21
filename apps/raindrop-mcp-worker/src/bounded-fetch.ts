import {
  BudgetExceededError,
  ExecutionBudget,
  ConcurrencyGate,
  UnknownWriteError,
} from "./execution-budget.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

export function createBoundedFetch(options: {
  budget: ExecutionBudget;
  gate: ConcurrencyGate;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const request = input instanceof Request ? input : new Request(input, init);
    const method = request.method.toUpperCase();
    const isWrite = isWriteMethod(method);
    const release = await options.gate.acquire(isWrite);
    try {
      options.budget.consumeAttempt();
      const remaining = options.budget.remainingMs();
      if (remaining <= 0) {
        throw new BudgetExceededError("Shared wall-clock budget exhausted.");
      }
      await assertRequestSize(request, options.budget.maxRequestBytes);
      const timeoutMs = Math.min(options.budget.fetchTimeoutMs, remaining);
      try {
        return await performWithRedirects(request, fetchImpl, timeoutMs, options.budget);
      } catch (error) {
        if (isWrite && isUncertainTransport(error)) {
          throw new UnknownWriteError(
            error instanceof Error ? error.message : "Write outcome is unknown.",
          );
        }
        throw error;
      }
    } finally {
      release();
    }
  };
}

async function performWithRedirects(
  original: Request,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  budget: ExecutionBudget,
): Promise<Response> {
  let current = original;
  for (let hop = 0; hop < 5; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status < 300 || response.status >= 400) {
      return limitResponse(response, budget.maxResponseBytes);
    }

    const location = response.headers.get("location");
    if (!location) return limitResponse(response, budget.maxResponseBytes);

    const nextUrl = new URL(location, current.url);
    const sameHost = nextUrl.host === new URL(current.url).host;
    const headers = new Headers(current.headers);
    if (!sameHost) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    current = new Request(nextUrl, {
      method: current.method,
      headers,
      body: current.method === "GET" || current.method === "HEAD" ? undefined : current.body,
      redirect: "manual",
    });
  }
  throw new Error("Too many redirects.");
}

async function assertRequestSize(request: Request, maxBytes: number): Promise<void> {
  const headerLength = request.headers.get("content-length");
  // Content-Length is not trusted as a permit; it can only fail closed early.
  if (headerLength && Number(headerLength) > maxBytes) {
    throw new BudgetExceededError("Request body exceeds size budget.");
  }
  if (request.body == null) return;
  const clone = request.clone();
  const bytes = new Uint8Array(await clone.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new BudgetExceededError("Request body exceeds size budget.");
  }
}

async function limitResponse(response: Response, maxBytes: number): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BudgetExceededError("Upstream response exceeded size budget.");
    }
    chunks.push(value);
  }
  const body = concat(chunks, total);
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return new Response(copy, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isUncertainTransport(error: unknown): boolean {
  if (error instanceof UnknownWriteError || error instanceof BudgetExceededError) {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  if (error instanceof SyntaxError) return true;
  return false;
}
