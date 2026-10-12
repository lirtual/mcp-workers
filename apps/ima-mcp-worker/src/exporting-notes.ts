import { ImaNotes } from "./ima.ts";
import { ImaApiError } from "./types.ts";
import type { ExportFileResult } from "./types.ts";
import { buildContentDisposition, buildDownloadUrl, buildR2Key, sanitizeFileName } from "./r2.ts";
import { refreshExpiredImaImageUrls } from "./note-image-resign.ts";

export class RefreshingImaNotes extends ImaNotes {
  override async exportNote(note_id: string, options: { file_name?: string } = {}): Promise<ExportFileResult> {
    if (!this.api.env.R2_BUCKET) {
      throw new ImaApiError("R2 bucket 未配置，无法导出文件", 110002);
    }
    const cleanNoteId = (note_id || "").trim();
    if (!cleanNoteId) {
      throw new ImaApiError("note_id 不能为空", 110001);
    }

    const noteData = await this.get(cleanNoteId, 1);
    const content = await refreshExpiredImaImageUrls(this.api, cleanNoteId, noteData?.content ?? "");

    let derivedName = options.file_name?.trim();
    if (!derivedName) {
      const headerMatch = content.match(/^#+\s+([^\r\n]+)/m);
      derivedName = headerMatch?.[1]?.trim() || `Note_${cleanNoteId}`;
    }

    const fileName = sanitizeFileName(derivedName, "md");
    const key = buildR2Key("notes", cleanNoteId, fileName);
    const contentType = "text/markdown; charset=utf-8";
    const contentDisposition = buildContentDisposition(fileName);
    const encodedBytes = new TextEncoder().encode(content);

    await this.api.env.R2_BUCKET.put(key, encodedBytes, {
      httpMetadata: { contentType, contentDisposition },
      customMetadata: {
        note_id: cleanNoteId,
        exported_at: new Date().toISOString(),
      },
    });

    const download_url = await buildDownloadUrl(this.api.env, key);
    return {
      download_url,
      file_name: fileName,
      file_size: encodedBytes.byteLength,
      content_type: contentType,
      note_id: cleanNoteId,
      key,
    };
  }
}
