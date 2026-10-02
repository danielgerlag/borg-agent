import {
  remoteRunStatusDocumentSchema,
  type RemoteRunStatusDocument,
} from "@borg-agent/contracts";
import { mkdir, rename, writeFile } from "node:fs/promises";
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
  const target = path.join(root, STATUS_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(temp, target);
}
