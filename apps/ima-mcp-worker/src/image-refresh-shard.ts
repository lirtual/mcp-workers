import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.ts";
import type { ImageRefreshBatchRequest, ImageRefreshBatchResult } from "./note-image-resign.ts";
import { processImageRefreshBatch } from "./note-image-resign.ts";

export class ImaImageRefreshShard extends DurableObject<Env> {
  async processBatch(request: ImageRefreshBatchRequest): Promise<ImageRefreshBatchResult[]> {
    return processImageRefreshBatch(this.env, request.credentials, request.items);
  }
}
