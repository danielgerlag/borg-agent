import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const URI_LIST_TYPE = "text/uri-list";
export const GNOME_COPIED_FILES_TYPE = "x-special/gnome-copied-files";
export const CLIPBOARD_FILE_LIMIT = 50;

function assertAbsoluteNativePath(nativePath: string): void {
  if (!path.isAbsolute(nativePath) || nativePath.includes("\0")) {
    throw new Error("Clipboard file paths must be absolute");
  }
}

function fileUriFromNativePath(nativePath: string): string {
  assertAbsoluteNativePath(nativePath);
  return pathToFileURL(nativePath).href;
}

function nativePathFromFileUri(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "file:") {
    return undefined;
  }
  try {
    const nativePath = fileURLToPath(parsed);
    return path.isAbsolute(nativePath) ? nativePath : undefined;
  } catch {
    return undefined;
  }
}

function uriLines(value: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const rawLine of value.split(/\r?\n/)) {
    if (rawLine.endsWith("\\")) {
      current += rawLine.slice(0, -1);
      continue;
    }
    const line = `${current}${rawLine}`.trim();
    current = "";
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    lines.push(line);
  }
  return lines;
}

export function encodeFileUriList(nativePaths: readonly string[]): string {
  return nativePaths.map(fileUriFromNativePath).join("\r\n");
}

export function decodeFileUriList(value: string): string[] {
  const paths: string[] = [];
  for (const line of uriLines(value)) {
    const nativePath = nativePathFromFileUri(line);
    if (nativePath) {
      paths.push(nativePath);
    }
    if (paths.length >= CLIPBOARD_FILE_LIMIT) {
      break;
    }
  }
  return paths;
}

export function encodeGnomeCopiedFiles(nativePaths: readonly string[]): string {
  return ["copy", ...nativePaths.map(fileUriFromNativePath)].join("\n");
}

export function decodeGnomeCopiedFiles(value: string): string[] {
  const lines = uriLines(value);
  const start =
    lines[0] === "copy" || lines[0] === "cut" ? lines.slice(1) : lines;
  const paths: string[] = [];
  for (const line of start) {
    const nativePath = nativePathFromFileUri(line);
    if (nativePath) {
      paths.push(nativePath);
    }
    if (paths.length >= CLIPBOARD_FILE_LIMIT) {
      break;
    }
  }
  return paths;
}

export function selectClipboardFilePaths(options: {
  readonly gnomeCopiedFiles?: string | undefined;
  readonly uriList?: string | undefined;
}): readonly string[] {
  if (options.gnomeCopiedFiles !== undefined) {
    const gnomePaths = decodeGnomeCopiedFiles(options.gnomeCopiedFiles);
    if (gnomePaths.length > 0) {
      return gnomePaths;
    }
  }
  if (options.uriList !== undefined) {
    return decodeFileUriList(options.uriList);
  }
  return [];
}
