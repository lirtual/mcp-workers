// Acceptance-only HTTP boundary. Never follow redirects carrying Raindrop
// Authorization; never send a read-test token to other hosts or methods.
export function createReadOnlyRaindropFetch(networkFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.origin !== "https://api.raindrop.io" ||
      !url.pathname.startsWith("/rest/v1/")
    ) {
      throw new Error("Read-only acceptance rejected an unexpected upstream request");
    }
    return networkFetch(new Request(request, { redirect: "error" }));
  };
}
