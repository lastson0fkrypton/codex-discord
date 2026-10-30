import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export const UPLOAD_LIMIT = 8 * 1024 * 1024;
export interface MediaAttachment { attachment: Buffer; name: string }
export interface MediaResult { caption: string; files: MediaAttachment[]; hashes: string[] }

function imageExtension(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (bytes.subarray(0, 6).toString().match(/^GIF8[79]a$/)) return "gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}

export class OutboundMedia {
  constructor(private projectPath: string) {}

  async forItem(item: Record<string, unknown>): Promise<MediaResult> {
    const generated = ["imageGeneration", "image_generation_call", "toolImage"].includes(String(item.type));
    const caption = item.type === "toolImage" ? "Tool image" : generated ? "Generated image" : "Reviewed image";
    try {
      let bytes: Buffer;
      const hasResult = generated && typeof item.result === "string" && item.result.trim().length > 0;
      const filePath = generated ? (hasResult ? undefined : item.savedPath) : item.path;
      if (typeof filePath === "string") {
        const candidate = await fs.realpath(path.resolve(this.projectPath, filePath));
        const roots = [this.projectPath, path.join(os.homedir(), ".codex", "generated_images")];
        const allowed = await Promise.all(roots.map(async (root) => {
          try {
            const realRoot = await fs.realpath(root);
            const relative = path.relative(realRoot, candidate);
            return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
          } catch { return false; }
        }));
        if (!allowed.some(Boolean)) return { caption: `${caption}: file is outside the project's allowed image roots.`, files: [], hashes: [] };
        const handle = await fs.open(candidate, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > UPLOAD_LIMIT) return { caption: `${caption}: unavailable or larger than the 8 MiB upload limit.`, files: [], hashes: [] };
          bytes = await handle.readFile();
        } finally { await handle.close(); }
      } else if (generated && typeof item.result === "string" && item.result) {
        const encoded = item.result.replace(/^data:image\/[\w+.-]+;base64,/, "");
        if (encoded.length > Math.ceil(UPLOAD_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(encoded)) {
          return { caption: `${caption}: invalid image data or larger than the 8 MiB upload limit.`, files: [], hashes: [] };
        }
        bytes = Buffer.from(encoded, "base64");
      } else {
        return { caption: `${caption}: no image data was provided by Codex.`, files: [], hashes: [] };
      }
      const extension = imageExtension(bytes);
      if (!extension || bytes.length > UPLOAD_LIMIT) return { caption: `${caption}: unsupported or oversized image.`, files: [], hashes: [] };
      const hash = createHash("sha256").update(bytes).digest("hex");
      return { caption, files: [{ attachment: bytes, name: `codex-image-${hash.slice(0, 12)}.${extension}` }], hashes: [hash] };
    } catch (error) {
      return { caption: `${caption}: could not read image (${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? "read failed" : "read failed"}).`, files: [], hashes: [] };
    }
  }
}
