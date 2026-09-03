import { defineCommand, defineEvent } from "@borg/contracts";
import {
  definePlugin,
  type BorgPluginManifest,
  type ConfigStoreProvider,
  type PluginContext,
  z,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CommandEventBus,
  CommandInvocationError,
  PluginManager,
  PersistenceRegistry,
  satisfiesBorgEngine,
  type PluginSource,
} from "../src";

const ping = defineCommand({
  id: "test.ping",
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
});

function createSource(id: string, engine = "^0.1.0"): PluginSource {
  const manifest = {
    id,
    version: "0.1.0",
    engines: { borg: engine },
    main: `${id}/main`,
    permissions: [],
    contributes: {
      commands: [ping.id],
    },
  } as const satisfies BorgPluginManifest;

  return {
    manifest,
    loadMain: async () =>
      definePlugin({
        id,
        version: manifest.version,
        engines: manifest.engines,
        permissions: manifest.permissions,
        contributes: manifest.contributes,
        activate(context) {
          context.bus.handle(ping, ({ value }) => ({ echoed: value }));
        },
      }),
  };
}

describe("PluginManager", () => {
  it("loads an in-process plugin and disposes its command", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");

    await expect(manager.activate(createSource("test.echo"))).resolves.toMatchObject({
      status: "active",
    });
    await expect(bus.invoke(ping, { value: "hello" })).resolves.toEqual({
      echoed: "hello",
    });

    await manager.deactivate("test.echo");
    await expect(bus.invoke(ping, { value: "after" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("issues scoped renderer capabilities that expire on deactivation", async () => {
    const manager = new PluginManager(new CommandEventBus(), "0.1.0");
    await manager.activate(createSource("test.capability"));
    const metadata = manager.getActivePluginMetadata()[0];

    expect(metadata?.uiCapability).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(manager.resolveUiCapability(metadata?.uiCapability ?? "")).toBe(
      "test.capability",
    );

    await manager.deactivate("test.capability");
    expect(manager.resolveUiCapability(metadata?.uiCapability ?? "")).toBeUndefined();
  });

  it("activates a default-satisfiable config store through the constrained bootstrap", async () => {
    const persistence = new PersistenceRegistry();
    const manager = new PluginManager(new CommandEventBus(), "0.1.0", {
      persistence,
    });
    const provider: ConfigStoreProvider = {
      readConfig: async () => undefined,
      writeConfig: async () => undefined,
      getStore: async () => undefined,
      listStore: async () => [],
      applyStoreTransaction: async () => undefined,
    };
    const manifest = {
      id: "test.config",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.config/main",
      permissions: [],
      contributes: { kinds: ["configStore"] },
    } as const satisfies BorgPluginManifest;

    await expect(
      manager.activateConfigStore({
        manifest,
        loadMain: async () =>
          definePlugin({
            ...manifest,
            configSchema: z.object({
              mode: z.string().default("safe"),
            }),
            activate(context) {
              context.persistence.registerConfigStore(provider);
            },
          }),
      }),
    ).resolves.toMatchObject({ status: "active" });
    expect(persistence.hasConfigStore()).toBe(true);
  });

  it("rejects bootstrap config defaults that are not JSON documents", async () => {
    const persistence = new PersistenceRegistry();
    const manager = new PluginManager(new CommandEventBus(), "0.1.0", {
      persistence,
    });
    const activate = vi.fn();
    const manifest = {
      id: "test.invalid-config",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.invalid-config/main",
      permissions: [],
      contributes: { kinds: ["configStore"] },
    } as const satisfies BorgPluginManifest;

    await expect(
      manager.activateConfigStore({
        manifest,
        loadMain: async () =>
          definePlugin({
            ...manifest,
            configSchema: z.string().default("not-an-object"),
            activate,
          }),
      }),
    ).rejects.toThrow(/requires unavailable configuration/);
    expect(activate).not.toHaveBeenCalled();
  });

  it("rejects an incompatible engine before importing plugin code", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const loadMain = vi.fn(createSource("test.future", "^2.0.0").loadMain);

    await expect(
      manager.activate({
        ...createSource("test.future", "^2.0.0"),
        loadMain,
      }),
    ).resolves.toMatchObject({
      id: "test.future",
      status: "incompatible",
    });
    expect(loadMain).not.toHaveBeenCalled();
  });

  it("rejects a malformed engine range before importing plugin code", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const loadMain = vi.fn(createSource("test.invalid-range", "not-semver || ").loadMain);

    await expect(
      manager.activate({
        ...createSource("test.invalid-range", "not-semver || "),
        loadMain,
      }),
    ).resolves.toMatchObject({
      status: "incompatible",
    });
    expect(loadMain).not.toHaveBeenCalled();
  });

  it("fails the second plugin that claims an existing command", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    await manager.activate(createSource("test.first"));

    await expect(manager.activate(createSource("test.second"))).rejects.toThrow(
      /already handled/,
    );
    expect(manager.getRecords()).toContainEqual(
      expect.objectContaining({ id: "test.second", status: "failed" }),
    );
    await expect(bus.invoke(ping, { value: "owner" })).resolves.toEqual({
      echoed: "owner",
    });
  });

  it("does not publish a command when activation later fails", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const source = createSource("test.rollback");

    await expect(
      manager.activate({
        manifest: source.manifest,
        loadMain: async () =>
          definePlugin({
            id: "test.rollback",
            version: "0.1.0",
            engines: { borg: "^0.1.0" },
            permissions: [],
            contributes: { commands: [ping.id] },
            activate(context) {
              context.bus.handle(ping, ({ value }) => ({ echoed: value }));
              throw new Error("activation failed");
            },
          }),
      }),
    ).rejects.toThrow("activation failed");
    expect(bus.provides(ping)).toBe(false);
  });

  it("keeps staged commands private while activation is pending", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const manifest = {
      id: "test.pending",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.pending/main",
      permissions: [],
      contributes: { commands: [ping.id] },
    } as const satisfies BorgPluginManifest;
    let releaseActivation: (() => void) | undefined;
    const enteredActivation = new Promise<void>((resolveEntered) => {
      releaseActivation = resolveEntered;
    });
    let continueActivation: (() => void) | undefined;
    const activationGate = new Promise<void>((resolveGate) => {
      continueActivation = resolveGate;
    });
    const activation = manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          id: manifest.id,
          version: manifest.version,
          engines: manifest.engines,
          permissions: manifest.permissions,
          contributes: manifest.contributes,
          async activate(context) {
            context.bus.handle(ping, ({ value }) => ({ echoed: value }));
            releaseActivation?.();
            await activationGate;
          },
        }),
    });

    await enteredActivation;
    expect(bus.provides(ping)).toBe(false);
    continueActivation?.();
    await activation;
    expect(bus.provides(ping)).toBe(true);
  });

  it("can reactivate a plugin after deactivation", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const source = createSource("test.restart");

    await manager.activate(source);
    await manager.deactivate("test.restart");
    await expect(manager.activate(source)).resolves.toMatchObject({ status: "active" });
    await expect(bus.invoke(ping, { value: "again" })).resolves.toEqual({
      echoed: "again",
    });
  });

  it("bounds a plugin that never finishes deactivating", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0", { shutdownTimeoutMs: 5 });
    const manifest = {
      id: "test.hanging-shutdown",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.hanging-shutdown/main",
      permissions: [],
      contributes: {},
    } as const satisfies BorgPluginManifest;

    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          id: manifest.id,
          version: manifest.version,
          engines: manifest.engines,
          permissions: manifest.permissions,
          contributes: manifest.contributes,
          activate: () => ({
            dispose: () => new Promise<void>(() => {}),
          }),
          deactivate: () => new Promise<void>(() => {}),
        }),
    });

    const startedAt = performance.now();
    await expect(manager.deactivate(manifest.id)).rejects.toThrow(/exceeded 5ms/);
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(manager.getRecords()).toContainEqual(
      expect.objectContaining({ id: manifest.id, status: "disabled" }),
    );
  });

  it("continues deactivating earlier plugins after a shutdown failure", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0", { shutdownTimeoutMs: 5 });
    const healthyDeactivation = vi.fn();
    const createLifecycleSource = (
      id: string,
      deactivate: () => void | Promise<void>,
    ): PluginSource => {
      const manifest = {
        id,
        version: "0.1.0",
        engines: { borg: "^0.1.0" },
        main: `${id}/main`,
        permissions: [],
        contributes: {},
      } as const satisfies BorgPluginManifest;
      return {
        manifest,
        loadMain: async () =>
          definePlugin({
            id,
            version: manifest.version,
            engines: manifest.engines,
            permissions: manifest.permissions,
            contributes: manifest.contributes,
            activate() {},
            deactivate,
          }),
      };
    };

    await manager.activate(
      createLifecycleSource("test.healthy-shutdown", healthyDeactivation),
    );
    await manager.activate(
      createLifecycleSource("test.failed-shutdown", () => {
        throw new Error("shutdown failed");
      }),
    );

    await manager.deactivateAll();
    expect(healthyDeactivation).toHaveBeenCalledOnce();
    expect(manager.getActivePluginIds()).toEqual([]);
  });

  it("revokes outbound bus access from a deactivated plugin context", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const source = createSource("test.revoked-context");
    let capturedContext: PluginContext | undefined;

    await manager.activate({
      manifest: source.manifest,
      loadMain: async () => {
        const loaded = await source.loadMain();
        const definition = "default" in loaded ? loaded.default : loaded;
        return {
          ...definition,
          activate(context: PluginContext) {
            capturedContext = context;
            return definition.activate(context);
          },
        };
      },
    });
    await manager.deactivate("test.revoked-context");

    expect(() => capturedContext?.bus.invoke(ping, { value: "late" })).toThrow(
      /no longer active/,
    );
  });
});

describe("satisfiesBorgEngine", () => {
  it("rejects leading zeroes and orders prerelease identifiers numerically", () => {
    expect(satisfiesBorgEngine("^0.1.0", "00.1.0")).toBe(false);
    expect(satisfiesBorgEngine(">1.0.0-beta.2", "1.0.0-beta.10")).toBe(true);
    expect(satisfiesBorgEngine("<1.0.0-beta.2", "1.0.0-beta.10")).toBe(false);
  });
});

describe("CommandEventBus", () => {
  it("returns the closed unavailable error when a command has no handler", async () => {
    const bus = new CommandEventBus();

    await expect(bus.invoke(ping, { value: "none" })).rejects.toEqual(
      expect.objectContaining<Partial<CommandInvocationError>>({
        code: "unavailable",
      }),
    );
  });

  it("isolates a failing event subscriber", async () => {
    const bus = new CommandEventBus();
    const changed = defineEvent({
      id: "test.changed",
      payload: z.object({ value: z.number() }),
    });
    const received: number[] = [];

    bus.on("test.bad-subscriber", changed, () => {
      throw new Error("subscriber failure");
    });
    bus.on("test.good-subscriber", changed, ({ value }) => {
      received.push(value);
    });

    await expect(
      bus.emit("test.emitter", new Set([changed.id]), changed, { value: 42 }),
    ).resolves.toBeUndefined();
    expect(received).toEqual([42]);
  });

  it("reports cooperative handler cancellation as a timeout", async () => {
    const bus = new CommandEventBus();
    const slow = defineCommand({
      id: "test.slow",
      timeoutMs: 5,
      input: z.object({}).strict(),
      output: z.object({ done: z.boolean() }),
    });
    bus.handle("test.slow-owner", new Set([slow.id]), slow, (_input, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    await expect(bus.invoke(slow, {})).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
