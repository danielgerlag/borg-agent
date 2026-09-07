import {
  driveReadOutputSchema,
  driveSearchOutputSchema,
  type DriveFile,
  type DriveReadOutput,
  type DriveSearchInput,
  type DriveSearchOutput,
} from "@borg/contracts";
import {
  GraphError,
  graphRequest,
  readString,
  type GraphClientOptions,
} from "./graph";
import {
  CALENDAR_DEFAULT_MAX_RESULTS,
  MAX_DRIVE_TEXT_CHARS,
  isDriveItemId,
  isRecord,
} from "./protocol";

export class GraphDriveClient {
  readonly #options: GraphClientOptions;

  constructor(options: GraphClientOptions) {
    this.#options = options;
  }

  async search(
    input: DriveSearchInput,
    signal?: AbortSignal,
  ): Promise<DriveSearchOutput> {
    const maxResults = input.maxResults ?? CALENDAR_DEFAULT_MAX_RESULTS;
    const query = new URLSearchParams({
      q: input.query,
      $top: String(maxResults),
      $select: "id,name,file,folder",
    });
    const body = await graphRequest(
      this.#options,
      `/v1.0/me/drive/root/search?${query.toString()}`,
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    if (!isRecord(body) || !Array.isArray(body.value)) {
      throw new GraphError(
        "invalid",
        undefined,
        "Graph returned an unusable drive search",
      );
    }
    const files: DriveFile[] = [];
    for (const item of body.value) {
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
      throw new GraphError("invalid", undefined, "Drive item id is invalid");
    }
    const body = await graphRequest(
      this.#options,
      `/v1.0/me/drive/items/${encodeURIComponent(input.id)}?$select=id,name,file,folder`,
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    const parsed = parseDriveFile(body);
    if (!parsed) {
      throw new GraphError(
        "invalid",
        undefined,
        "Graph returned an unusable drive item",
      );
    }
    if (!isReadableTextMimeType(parsed.mimeType)) {
      return driveReadOutputSchema.parse(parsed);
    }
    try {
      const text = await graphRequest(
        this.#options,
        `/v1.0/me/drive/items/${encodeURIComponent(input.id)}/content`,
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
        error instanceof GraphError &&
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
  const file = isRecord(value.file) ? value.file : undefined;
  const mimeType = file ? readString(file.mimeType) : undefined;
  return {
    id: value.id,
    name,
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
}
