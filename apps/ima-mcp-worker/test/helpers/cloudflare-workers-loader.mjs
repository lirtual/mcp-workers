const STUB_URL = "data:text/javascript," + encodeURIComponent(`
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
