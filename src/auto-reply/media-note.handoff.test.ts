import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPendingHandoffImages } from "./media-note.js";

describe("readPendingHandoffImages", () => {
  let workspaceDir: string;
  let pendingFile: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-handoff-images-"));
    fs.mkdirSync(path.join(workspaceDir, "data"));
    pendingFile = path.join(workspaceDir, "data/pending-handoff-images.json");
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("keeps valid images with optional MIME types and trims their fields", () => {
    const raw = JSON.stringify({
      images: [
        { path: " /tmp/a.png ", mime: " image/png " },
        { path: " /tmp/b.jpg " },
        { path: "/tmp/c.jpg", mime: 7 },
      ],
    });
    fs.writeFileSync(pendingFile, raw);

    expect(readPendingHandoffImages(workspaceDir)).toStrictEqual([
      { path: "/tmp/a.png", mime: "image/png" },
      { path: "/tmp/b.jpg", mime: undefined },
      { path: "/tmp/c.jpg", mime: undefined },
    ]);
    expect(fs.readFileSync(pendingFile, "utf-8")).toBe(raw);
  });

  it("filters invalid entries without dropping valid images", () => {
    fs.writeFileSync(
      pendingFile,
      JSON.stringify({
        images: [null, false, "image", 5, {}, { path: 7 }, { path: " " }, { path: "/tmp/a.png" }],
      }),
    );

    expect(readPendingHandoffImages(workspaceDir)).toStrictEqual([
      { path: "/tmp/a.png", mime: undefined },
    ]);
  });

  it("returns no images when the workspace or pending file is absent", () => {
    expect(readPendingHandoffImages(undefined)).toEqual([]);
    expect(readPendingHandoffImages("")).toEqual([]);
    expect(readPendingHandoffImages(" ")).toEqual([]);
    expect(readPendingHandoffImages(workspaceDir)).toEqual([]);
  });

  it.each(["not json", "null", "{}", '{"images":null}', '{"images":{}}', '{"images":[]}'])(
    "returns no images for an invalid or empty payload: %s",
    (raw) => {
      fs.writeFileSync(pendingFile, raw);

      expect(readPendingHandoffImages(workspaceDir)).toEqual([]);
      expect(fs.readFileSync(pendingFile, "utf-8")).toBe(raw);
    },
  );
});
