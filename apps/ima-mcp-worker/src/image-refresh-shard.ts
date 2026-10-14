import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.ts";

// Compatibility only: preserve the deployed SQLite DO class/binding without any
// export or image-refresh RPCs. Cloudflare resource deletion is a separate action.
export class ImaImageRefreshShard extends DurableObject<Env> {}
