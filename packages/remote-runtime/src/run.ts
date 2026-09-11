import {
  remoteRunSpecSchema,
  type RemoteRunSpec,
  type RemoteRunStatusDocument,
} from "@borg/contracts";
import { LoopManager } from "@borg/kernel";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { composeRuntime } from "./compose";
import {
  SPEC_FILE,
  WORKSPACE_DIR,
  writeStatus,
} from "./status";

export async function runDetachedLoop(root: string): Promise<void> {
  const spec = remoteRunSpecSchema.parse(
    JSON.parse(await readFile(path.join(root, SPEC_FILE), "utf8")),
  ) as RemoteRunSpec;
  const workspaceRoot = path.join(root, WORKSPACE_DIR);
  await mkdir(workspaceRoot, { recursive: true });
  await writeStatus(root, {
    version: 1,
    runId: spec.runId,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  const { loops, workspaces } = await composeRuntime({
    spec,
    workspaceRoot,
  });
  workspaces.allocate("borg.runtime", spec.runId);
  const providerId =
    spec.provider.kind === "scripted"
      ? "borg.runtime.scripted"
      : "borg.runtime.openai";
  const modelId =
    spec.provider.kind === "scripted" ? "scripted" : spec.provider.model;
  try {
    const snapshot = await loops.start(
      {
        prompt: spec.prompt,
        personaId: spec.persona.id,
        sessionId: spec.runId,
        providerId,
        modelId,
        allowedTools: spec.persona.allowedTools,
        security: {
          kind: "root",
          subject: {
            kind: "remote-run",
            id: spec.runId,
          },
          classification: "internal",
          provenance: {
            kind: "plugin",
            id: "borg.runtime",
          },
          operationPrefix: `remote/${spec.runId}`,
        },
      },
      "borg.runtime",
    );
    await waitForTerminal(loops, snapshot.id);
    const finished = loops.get(snapshot.id, "borg.runtime");
    if (finished?.status === "completed") {
      await writeStatus(
        root,
        statusDocument(spec.runId, "completed", {
          output: finished.output,
        }),
      );
      return;
    }
    await writeStatus(
      root,
      statusDocument(
        spec.runId,
        finished?.status === "cancelled" ? "cancelled" : "failed",
        {
          error: finished?.error ?? `Run ended ${finished?.status ?? "missing"}`,
        },
      ),
    );
  } catch (error) {
    await writeStatus(
      root,
      statusDocument(spec.runId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

function statusDocument(
  runId: string,
  status: RemoteRunStatusDocument["status"],
  extras: {
    readonly output?: string | undefined;
    readonly error?: string | undefined;
  } = {},
): RemoteRunStatusDocument {
  return {
    version: 1,
    runId,
    status,
    ...(extras.output !== undefined ? { output: extras.output } : {}),
    ...(extras.error !== undefined ? { error: extras.error } : {}),
    updatedAt: new Date().toISOString(),
  };
}

async function waitForTerminal(
  loops: LoopManager,
  runId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (next: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      next();
    };
    const done = (): void => {
      const snapshot = loops.get(runId, "borg.runtime");
      if (
        snapshot &&
        (snapshot.status === "completed" ||
          snapshot.status === "failed" ||
          snapshot.status === "cancelled")
      ) {
        finish(resolve);
      }
    };
    const subscription = loops.subscribeRun(runId, "borg.runtime", done);
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Detached run timed out")));
    }, 60_000);
    done();
  });
}
