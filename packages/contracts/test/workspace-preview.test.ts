import { describe, expect, it } from "vitest";
import {
  workspaceImportResultSchema,
  workspacePreviewSchema,
} from "../src/index";

describe("workspace preview contracts", () => {
  it("discriminates text, image, and binary previews", () => {
    expect(
      workspacePreviewSchema.parse({
        kind: "text",
        path: "notes/hello.txt",
        size: 21,
        content: "Created by Borg chat.",
        truncated: false,
      }),
    ).toMatchObject({ kind: "text", truncated: false });
    expect(
      workspacePreviewSchema.parse({
        kind: "image",
        path: "photo.png",
        size: 12,
        mimeType: "image/png",
        content: "aa==",
      }),
    ).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(
      workspacePreviewSchema.parse({
        kind: "binary",
        path: "blob.bin",
        size: 4,
      }),
    ).toEqual({ kind: "binary", path: "blob.bin", size: 4 });
    expect(() =>
      workspacePreviewSchema.parse({
        kind: "text",
        path: "notes/hello.txt",
        size: 1,
        content: "x",
      }),
    ).toThrow();
  });

  it("parses an import result", () => {
    expect(
      workspaceImportResultSchema.parse({
        files: [
          {
            path: "note.txt",
            size: 4,
            updatedAt: "2026-09-09T00:00:00.000Z",
          },
        ],
        imported: 1,
        skipped: 0,
      }),
    ).toMatchObject({ imported: 1, skipped: 0 });
  });
});
