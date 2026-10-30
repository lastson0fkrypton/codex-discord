import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OutboundMedia, UPLOAD_LIMIT } from "./outbound-media.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
describe("outbound Codex images", () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-media-")); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  it("attaches reviewed project images and generated base64 with the same identity", async () => {
    await fs.writeFile(path.join(directory, "image.png"), png);
    const media = new OutboundMedia(directory);
    const reviewed = await media.forItem({ type: "imageView", path: "image.png" });
    const generated = await media.forItem({ type: "imageGeneration", result: png.toString("base64") });
    expect(reviewed.files[0].attachment).toEqual(png);
    expect(reviewed.files[0].name).toMatch(/\.png$/);
    expect(reviewed.hashes).toEqual(generated.hashes);
    expect(generated.caption).toBe("Generated image");
  });
  it("rejects a symlink escaping the project image roots", async () => {
    await fs.mkdir(path.join(directory, "project"));
    await fs.writeFile(path.join(directory, "private.png"), png);
    await fs.symlink(path.join(directory, "private.png"), path.join(directory, "project", "link.png"));
    const result = await new OutboundMedia(path.join(directory, "project")).forItem({ type: "imageView", path: "link.png" });
    expect(result.files).toEqual([]);
    expect(result.caption).toContain("outside");
  });
  it("reports missing, invalid and oversized images without uploading them", async () => {
    const media = new OutboundMedia(directory);
    expect((await media.forItem({ type: "imageView", path: "missing.png" })).caption).toContain("ENOENT");
    expect((await media.forItem({ type: "imageGeneration", result: Buffer.from("not an image").toString("base64") })).files).toEqual([]);
    const file = await fs.open(path.join(directory, "large.png"), "w");
    await file.truncate(UPLOAD_LIMIT + 1);
    await file.close();
    const result = await media.forItem({ type: "imageView", path: "large.png" });
    expect(result.files).toEqual([]);
    expect(result.caption).toContain("8 MiB");
  });
});
