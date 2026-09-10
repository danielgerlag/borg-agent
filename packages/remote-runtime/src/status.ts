import {
  remoteRunStatusDocumentSchema,
  type RemoteRunStatusDocument,
} from "@borg/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const SPEC_FILE = "spec.json";
export const STATUS_FILE = "status.json";
export const WORKSPACE_DIR = "workspace";

export async function writeStatus(
  root: string,
  document: RemoteRunStatusDocument,
): Promise<void> {
  const parsed = remoteRunStatusDocumentSchema.parse(document);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, STATUS_FILE),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
}
