import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_FILE_LIMIT,
  decodeFileUriList,
  decodeGnomeCopiedFiles,
  encodeFileUriList,
  encodeGnomeCopiedFiles,
  selectClipboardFilePaths,
} from "../src/main/native-file-clipboard";

describe("native file clipboard", () => {
  const left = path.join(os.tmpdir(), "borg-clip-a.txt");
  const right = path.join(os.tmpdir(), "borg-clip-b.txt");

  it("round-trips RFC 2483 file URI lists", () => {
    const encoded = encodeFileUriList([left, right]);
    expect(encoded).toContain("\r\n");
    expect(encoded).toContain("file:");
    expect(decodeFileUriList(encoded)).toEqual([left, right]);
    expect(
      decodeFileUriList(`# comment\nhttp://example.test/skip\n${encoded}`),
    ).toEqual([left, right]);
  });

  it("encodes Nautilus gnome-copied-files as copy plus file URIs", () => {
    const encoded = encodeGnomeCopiedFiles([left, right]);
    expect(encoded.startsWith("copy\n")).toBe(true);
    expect(decodeGnomeCopiedFiles(encoded)).toEqual([left, right]);
    expect(decodeGnomeCopiedFiles(`cut\n${encoded.slice("copy\n".length)}`)).toEqual(
      [left, right],
    );
  });

  it("prefers gnome-copied-files then uri-list and caps at 50", () => {
    expect(
      selectClipboardFilePaths({
        gnomeCopiedFiles: encodeGnomeCopiedFiles([left]),
        uriList: encodeFileUriList([right]),
      }),
    ).toEqual([left]);
    expect(
      selectClipboardFilePaths({
        uriList: encodeFileUriList([right]),
      }),
    ).toEqual([right]);
    expect(selectClipboardFilePaths({})).toEqual([]);
    const many = Array.from({ length: CLIPBOARD_FILE_LIMIT + 5 }, (_, index) =>
      path.join(os.tmpdir(), `clip-${index}.txt`),
    );
    expect(decodeFileUriList(encodeFileUriList(many))).toHaveLength(
      CLIPBOARD_FILE_LIMIT,
    );
  });

  it("rejects relative clipboard paths", () => {
    expect(() => encodeFileUriList(["relative.txt"])).toThrow(/absolute/);
  });
});
