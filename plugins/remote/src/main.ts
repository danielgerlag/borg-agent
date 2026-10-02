import {
  remoteDestroy,
  remoteGetRun,
  remoteListWorkers,
  remoteProvision,
  remoteSubmitRun,
} from "@borg-agent/contracts";
import { definePlugin, type PluginContext } from "@borg-agent/plugin-sdk";
import { createRequire } from "node:module";
import path from "node:path";
import { createAzureVmProvider } from "./azure-vm";
import { createKubernetesProvider } from "./kubernetes";
import { createLocalProvider, defaultSpawnDetached } from "./local";
import {
  RemoteOrchestrator,
  type RemoteFetch,
  type RemoteProvider,
  type RemoteRuntimeId,
} from "./orchestrator";

function resolveRuntimeCliPath(): string {
  const override = process.env.BORG_RUNTIME_CLI?.trim();
  if (override) {
    return override;
  }
  const require = createRequire(__filename);
  return path.join(
    path.dirname(require.resolve("@borg/remote-runtime/package.json")),
    "dist/cli.js",
  );
}

function bindFetch(context: PluginContext): RemoteFetch {
  return (input, init) =>
    init === undefined
      ? context.http.fetch(input)
      : context.http.fetch(input, init);
}

export function createRemoteOrchestrator(
  context: PluginContext,
  options?: {
    readonly spawnDetached?: typeof defaultSpawnDetached;
    readonly cliPath?: string;
    readonly execPath?: string;
    readonly now?: () => Date;
  },
): RemoteOrchestrator {
  const fetchImpl = bindFetch(context);
  const now = options?.now;
  const providers = new Map<RemoteRuntimeId, RemoteProvider>([
    [
      "local",
      createLocalProvider({
        store: context.store,
        dataDir: context.dataDir,
        cliPath: options?.cliPath ?? resolveRuntimeCliPath(),
        execPath: options?.execPath ?? process.execPath,
        spawnDetached: options?.spawnDetached ?? defaultSpawnDetached,
        ...(now !== undefined ? { now } : {}),
      }),
    ],
    [
      "azure-vm",
      createAzureVmProvider({
        store: context.store,
        fetch: fetchImpl,
        getToken: () => context.secrets.get("armToken"),
        ...(now !== undefined ? { now } : {}),
      }),
    ],
    [
      "kubernetes",
      createKubernetesProvider({
        store: context.store,
        secrets: context.secrets,
        fetch: fetchImpl,
        ...(now !== undefined ? { now } : {}),
      }),
    ],
  ]);
  return new RemoteOrchestrator(providers);
}

export default definePlugin({
  id: "borg.remote",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "ui.settings",
    "network:dynamic",
    "secrets:read",
    "secrets:write",
    "fs:pluginData",
  ],
  contributes: {
    commands: [
      remoteListWorkers.id,
      remoteProvision.id,
      remoteDestroy.id,
      remoteSubmitRun.id,
      remoteGetRun.id,
    ],
    kinds: ["settingsPage"],
  },
  activate(context) {
    const orchestrator = createRemoteOrchestrator(context);
    context.bus.handle(remoteListWorkers, async () => ({
      workers: [...(await orchestrator.list())],
    }));
    context.bus.handle(remoteProvision, async (input) => ({
      worker: await orchestrator.provision(input),
    }));
    context.bus.handle(remoteDestroy, async (input) => ({
      destroyed: await orchestrator.destroy(input.workerId),
    }));
    context.bus.handle(remoteSubmitRun, async (input) => ({
      runId: await orchestrator.submitRun(input.workerId, input.spec),
    }));
    context.bus.handle(remoteGetRun, async (input) =>
      orchestrator.getRun(input.workerId, input.runId),
    );
  },
});
