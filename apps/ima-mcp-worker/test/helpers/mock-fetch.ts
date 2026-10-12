export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBody?: string;
}

export type MockFetchHandler = (req: CapturedRequest) => Response | Promise<Response>;

export function setupMockFetch(handler: MockFetchHandler) {
  const originalFetch = globalThis.fetch;
  const captured: CapturedRequest[] = [];

  const mock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
    }

    const method = init?.method || (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
    const headers: Record<string, string> = {};

    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }

    let rawBody: string | undefined;
    let body: any;

    if (init?.body) {
      if (typeof init.body === "string") {
        rawBody = init.body;
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
    }

    const capturedReq: CapturedRequest = {
      url,
      method,
      headers,
      body,
      rawBody,
    };
    captured.push(capturedReq);

    return await handler(capturedReq);
  };

  globalThis.fetch = mock as any;

  return {
    captured,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
