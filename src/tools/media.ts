import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { defineTool, type Ctx } from "./helpers.js";

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
  csv: "text/csv",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export function registerMediaTools(ctx: Ctx): void {
  defineTool(ctx, {
    name: "wp_media_upload",
    description:
      'Upload a file to the media library from exactly one source: a local `file_path` on the machine running this server, a public `url`, or `base64` data. List, edit and delete media with wp_list/wp_update/wp_delete using resource "media".',
    schema: {
      file_path: z.string().optional(),
      url: z.string().url().optional(),
      base64: z.string().optional(),
      filename: z.string().optional().describe("Required with base64; otherwise taken from the path or URL"),
      title: z.string().optional(),
      alt_text: z.string().optional(),
      caption: z.string().optional(),
      description: z.string().optional(),
      post: z.number().int().optional().describe("Attach to this post id"),
    },
    kind: "write",
    run: async (wp, a) => {
      const sources = [a.file_path, a.url, a.base64].filter((s) => s !== undefined);
      if (sources.length !== 1) throw new Error("Provide exactly one of file_path, url or base64.");

      let bytes: Uint8Array;
      let filename = a.filename;
      if (a.file_path) {
        bytes = await readFile(a.file_path);
        filename ??= basename(a.file_path);
      } else if (a.url) {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`Could not download ${a.url}: HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
        filename ??= basename(new URL(a.url).pathname) || undefined;
      } else {
        bytes = Buffer.from(a.base64!, "base64");
      }
      if (!filename) throw new Error("filename is required when it cannot be derived from the source.");

      const uploaded = await wp.request<{ id: number }>("POST", "/wp/v2/media", {
        rawBody: bytes,
        headers: {
          "Content-Type": mimeFor(filename),
          "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        },
        timeoutMs: 180_000,
      });

      const meta = { title: a.title, alt_text: a.alt_text, caption: a.caption, description: a.description, post: a.post };
      const hasMeta = Object.values(meta).some((v) => v !== undefined);
      const item = hasMeta ? (await wp.post<any>(`/wp/v2/media/${uploaded.data.id}`, meta)).data : (uploaded.data as any);
      return {
        id: item.id,
        source_url: item.source_url,
        mime_type: item.mime_type,
        title: item.title?.rendered ?? item.title?.raw,
        alt_text: item.alt_text,
        media_details: item.media_details && { width: item.media_details.width, height: item.media_details.height },
      };
    },
  });
}
