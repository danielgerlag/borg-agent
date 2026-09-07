import {
  driveReadOutputSchema,
  driveSearchOutputSchema,
  type DriveFile,
  type DriveReadOutput,
  type DriveSearchInput,
  type DriveSearchOutput,
} from "@borg/contracts";
import {
  GoogleApisError,
  googleApisRequest,
  isRecord,
  readString,
  type GoogleApisClientOptions,
} from "./googleapis";
import {
  CALENDAR_DEFAULT_MAX_RESULTS,
  MAX_DRIVE_TEXT_CHARS,
  isDriveItemId,
} from "./protocol";

export class GoogleDriveClient {
  readonly #options: GoogleApisClientOptions;

  constructor(options: GoogleApisClientOptions) {
    this.#options = options;
  }

  async search(
    input: DriveSearchInput,
    signal?: AbortSignal,
  ): Promise<DriveSearchOutput> {
    const maxResults = input.maxResults ?? CALENDAR_DEFAULT_MAX_RESULTS;
    const query = new URLSearchParams({
      q: input.query,
      pageSize: String(maxResults),
      fields: "files(id,name,mimeType)",
    });
    const body = await googleApisRequest(
      this.#options,
      `/drive/v3/files?${query.toString()}`,
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    if (!isRecord(body) || !Array.isArray(body.files)) {
      throw new GoogleApisError(
        "invalid",
        undefined,
        "Google returned an unusable Drive search",
      );
    }
    const files: DriveFile[] = [];
    for (const item of body.files) {
      const parsed = parseDriveFile(item);
      if (parsed && files.length < maxResults) {
        files.push(parsed);
      }
    }
    return driveSearchOutputSchema.parse({ files });
  }

  async read(
    input: { readonly id: string },
    signal?: AbortSignal,
  ): Promise<DriveReadOutput> {
    if (!isDriveItemId(input.id)) {
      throw new GoogleApisError("invalid", undefined, "Drive item id is invalid");
    }
    const encodedId = encodeURIComponent(input.id);
    const body = await googleApisRequest(
      this.#options,
      `/drive/v3/files/${encodedId}?fields=id,name,mimeType`,
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    const parsed = parseDriveFile(body);
    if (!parsed) {
      throw new GoogleApisError(
        "invalid",
        undefined,
        "Google returned an unusable Drive file",
      );
    }
    if (!isReadableTextMimeType(parsed.mimeType)) {
      return driveReadOutputSchema.parse(parsed);
    }
    try {
      const text = await googleApisRequest(
        this.#options,
        `/drive/v3/files/${encodedId}?alt=media`,
        {
          method: "GET",
          accept: "text/plain, */*;q=0.1",
          mode: "text",
          ...(signal ? { signal } : {}),
        },
      );
      if (typeof text !== "string" || text.includes("\0")) {
        return driveReadOutputSchema.parse(parsed);
      }
      return driveReadOutputSchema.parse({
        ...parsed,
        text: truncateDriveText(text),
      });
    } catch (error) {
      if (
        error instanceof GoogleApisError &&
        (error.code === "auth" || error.code === "forbidden")
      ) {
        throw error;
      }
      return driveReadOutputSchema.parse(parsed);
    }
  }
}

export function isReadableTextMimeType(
  mimeType: string | undefined,
): boolean {
  if (mimeType === undefined || mimeType.length === 0) {
    return false;
  }
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("application/vnd.google-apps.")) {
    return false;
  }
  return (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/xml" ||
    base === "application/javascript" ||
    base.endsWith("+json") ||
    base.endsWith("+xml")
  );
}

export function truncateDriveText(
  value: string,
  max = MAX_DRIVE_TEXT_CHARS,
): string {
  return value.length <= max ? value : value.slice(0, max);
}

function parseDriveFile(value: unknown): DriveFile | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return undefined;
  }
  if (!isDriveItemId(value.id)) {
    return undefined;
  }
  const name = readString(value.name);
  if (!name) {
    return undefined;
  }
  const mimeType = readString(value.mimeType);
  return {
    id: value.id,
    name,
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
}
