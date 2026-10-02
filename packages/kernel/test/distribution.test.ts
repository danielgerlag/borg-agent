import { modelOperationKeySchema } from "@borg-agent/contracts";
import type { PluginContext } from "@borg-agent/plugin-sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KERNEL_API_VERSION,
  createKernel,
  defineDistribution,
  type Distribution,
  type Kernel,
  type KernelHost,
  type PluginSource,
} from "../src";
import { minimalDistribution } from "./fixtures/minimal-distribution";
import { MemoryConfigStore, MemorySecretStore, sourceFor } from "./support/memory-plugins";

const directory = path.dirname(fileURLToPath(import.meta.url));

function unreadHost(): KernelHost {
  return {
    get dataDirectory(): string {
      throw new Error("host was read");
    },
  };
}

function rejectionKernel(
  distribution: Distribution,
  plugins: readonly PluginSource[],
) {
  return () =>
    createKernel({
      plugins,
      distribution,
      host: unreadHost(),
      resolveSecretStore: async () => {
        throw new Error("resolveSecretStore was called");
      },
    });
}

function configSource(id = "example.config", store = new MemoryConfigStore()) {
  return sourceFor({
    id,
    version: "0.1.0",
    engines: { borg: "^0.1.0" },
    permissions: [],
    contributes: { kinds: ["configStore"] },
    activate(context) {
      context.persistence.registerConfigStore(store);
    },
  });
}

function secretSource() {
  return sourceFor({
    id: "example.secrets",
    version: "0.1.0",
    engines: { borg: "^0.1.0" },
    permissions: [],
    contributes: { kinds: ["secretStore"] },
    activate(context) {
      context.persistence.registerSecretStore(new MemorySecretStore());
    },
  });
}

describe("defineDistribution", () => {
  it("normalizes string entries and freezes the result", () => {
    const distribution = defineDistribution({
      id: "example.freeze",
      name: "Freeze",
      version: "0.1.0",
      kernel: "^0.1.0",
      plugins: ["example.config", { id: "example.optional", enabled: false }],
      defaults: { models: ["example.llm:scripted"] },
      policy: {
        detachedResults: [
          { pluginId: "example.optional", subjectKinds: ["sample-run"] },
        ],
      },
    });

    expect(distribution.plugins).toEqual([
      { id: "example.config", enabled: true },
      { id: "example.optional", enabled: false },
    ]);
    expect(Object.isFrozen(distribution)).toBe(true);
    expect(Object.isFrozen(distribution.plugins)).toBe(true);
    expect(Object.isFrozen(distribution.plugins[1])).toBe(true);
    expect(Object.isFrozen(distribution.defaults)).toBe(true);
    expect(Object.isFrozen(distribution.defaults.models)).toBe(true);
    expect(Object.isFrozen(distribution.policy)).toBe(true);
    expect(Object.isFrozen(distribution.policy.detachedResults)).toBe(true);
    expect(Object.isFrozen(distribution.policy.detachedResults?.[0])).toBe(true);
    expect(Object.isFrozen(distribution.policy.detachedResults?.[0]?.subjectKinds)).toBe(true);
    expect(Object.isFrozen(minimalDistribution)).toBe(true);
    expect(minimalDistribution.plugins[0]).toEqual({
      id: "example.config",
      enabled: true,
    });
  });

  it("rejects duplicate plugin ids, a bad id, bad semver, an invalid kernel range, an empty plugin list, and a bad model preference", () => {
    expect(() =>
      defineDistribution({
        id: "example.dupes",
        name: "Dupes",
        version: "0.1.0",
        kernel: "^0.1.0",
        plugins: ["example.config", "example.config"],
      }),
    ).toThrow(/Invalid distribution example\.dupes:[\s\S]*duplicate plugin id example\.config/);

    expect(() =>
      defineDistribution({
        id: "not a plugin id",
        name: "Bad",
        version: "0.1.0",
        kernel: "^0.1.0",
        plugins: ["example.config"],
      }),
    ).toThrow(/Invalid distribution not a plugin id:[\s\S]*not a valid plugin id/);

    expect(() =>
      defineDistribution({
        id: "example.version",
        name: "Version",
        version: "1.0",
        kernel: "^0.1.0",
        plugins: ["example.config"],
      }),
    ).toThrow(/Invalid distribution example\.version:[\s\S]*not valid semver/);

    expect(() =>
      defineDistribution({
        id: "example.range",
        name: "Range",
        version: "0.1.0",
        kernel: "not-a-range",
        plugins: ["example.config"],
      }),
    ).toThrow(/Invalid distribution example\.range:[\s\S]*kernel range "not-a-range" is invalid/);

    expect(() =>
      defineDistribution({
        id: "example.empty",
        name: "Empty",
        version: "0.1.0",
        kernel: "^0.1.0",
        plugins: [],
      }),
    ).toThrow(/Invalid distribution example\.empty:[\s\S]*at least one plugin/);

    expect(() =>
      defineDistribution({
        id: "example.model",
        name: "Model",
        version: "0.1.0",
        kernel: "^0.1.0",
        plugins: ["example.config"],
        defaults: { models: ["nope"] },
      }),
    ).toThrow(/Invalid distribution example\.model:[\s\S]*model preference "nope" must be provider:model/);

    expect(() =>
      defineDistribution({
        id: "example.many",
        name: "",
        version: "1.0",
        kernel: "not-a-range",
        plugins: ["example.config", "example.config"],
        defaults: { models: ["nope"] },
      }),
    ).toThrow(
      /Invalid distribution example\.many:[\s\S]*name must be a non-empty string[\s\S]*not valid semver[\s\S]*kernel range "not-a-range" is invalid[\s\S]*duplicate plugin id example\.config[\s\S]*model preference "nope" must be provider:model/,
    );
  });

  it("keeps the README example equal to the fixture", () => {
    const readme = readFileSync(path.join(directory, "../README.md"), "utf8");
    const block = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .find((code) => code?.includes("export const minimalDistribution"));
    expect(block).toBeDefined();
    const fixture = readFileSync(
      path.join(directory, "fixtures/minimal-distribution.ts"),
      "utf8",
    );
    expect(block?.replaceAll('from "@borg-agent/kernel"', 'from "../../src"')).toBe(fixture);
  });
});

describe("createKernel distribution", () => {
  let dataDirectory: string | undefined;
  let kernel: Kernel | undefined;

  afterEach(async () => {
    await kernel?.stop();
    kernel = undefined;
    if (dataDirectory !== undefined) {
      rmSync(dataDirectory, { recursive: true, force: true });
      dataDirectory = undefined;
    }
  });

  it("rejects an incompatible kernel range before reading the host", () => {
    const distribution = defineDistribution({
      id: "example.range",
      name: "Range",
      version: "0.1.0",
      kernel: "^0.2.0",
      plugins: ["example.config"],
    });

    expect(rejectionKernel(distribution, [configSource()])).toThrow(
      new RegExp(
        `Distribution example\\.range@0\\.1\\.0 cannot run on this kernel:[\\s\\S]*kernel range \\^0\\.2\\.0 is not satisfied by kernel API version ${KERNEL_API_VERSION}`,
      ),
    );
  });

  it("rejects a declared plugin with no source", () => {
    const distribution = defineDistribution({
      id: "example.missing",
      name: "Missing",
      version: "0.1.0",
      kernel: "^0.1.0",
      plugins: ["example.config", "example.missing"],
    });

    expect(rejectionKernel(distribution, [configSource()])).toThrow(
      /Distribution example\.missing@0\.1\.0 cannot run on this kernel:[\s\S]*missing plugin source example\.missing/,
    );
  });

  it("rejects duplicate plugin ids in a hand-built distribution", () => {
    const distribution: Distribution = {
      id: "example.hand",
      name: "Hand",
      version: "0.1.0",
      kernel: "^0.1.0",
      plugins: [
        { id: "example.config", enabled: true },
        { id: "example.config", enabled: true },
      ],
      defaults: {},
      policy: {},
    };

    expect(rejectionKernel(distribution, [configSource()])).toThrow(
      /Distribution example\.hand@0\.1\.0 cannot run on this kernel:[\s\S]*duplicate plugin id example\.config/,
    );
  });

  it("rejects two sources that share a declared id", () => {
    const distribution = defineDistribution({
      id: "example.sources",
      name: "Sources",
      version: "0.1.0",
      kernel: "^0.1.0",
      plugins: ["example.config"],
    });

    expect(
      rejectionKernel(distribution, [configSource(), configSource("example.config")]),
    ).toThrow(
      /Distribution example\.sources@0\.1\.0 cannot run on this kernel:[\s\S]*duplicate plugin source example\.config/,
    );
  });

  it("lists every compatibility problem in one error and does not start", () => {
    const distribution: Distribution = {
      id: "example.several",
      name: "Several",
      version: "0.1.0",
      kernel: "^0.2.0",
      plugins: [
        { id: "example.config", enabled: true },
        { id: "example.missing", enabled: true },
      ],
      defaults: {},
      policy: {},
    };

    expect(
      rejectionKernel(distribution, [configSource(), configSource()]),
    ).toThrow(
      /Distribution example\.several@0\.1\.0 cannot run on this kernel:[\s\S]*kernel range \^0\.2\.0 is not satisfied by kernel API version 0\.1\.0[\s\S]*duplicate plugin source example\.config[\s\S]*missing plugin source example\.missing/,
    );
  });

  it("rejects hand-built distributions that defineDistribution would reject", () => {
    const valid: Distribution = {
      id: "example.hand",
      name: "Hand",
      version: "0.1.0",
      kernel: "^0.1.0",
      plugins: [{ id: "example.config", enabled: true }],
      defaults: {},
      policy: {},
    };
    const cases: readonly [string, unknown, RegExp][] = [
      ["id syntax", { ...valid, id: "Not An Id" }, /id "Not An Id" is not a valid plugin id/],
      [
        "model format",
        { ...valid, defaults: { models: ["no-separator"] } },
        /model preference "no-separator" must be provider:model/,
      ],
      [
        "non-boolean enabled",
        { ...valid, plugins: [{ id: "example.config", enabled: "no" }] },
        /plugins\[0\]\.enabled must be a boolean/,
      ],
      [
        "bad plugin id",
        { ...valid, plugins: [{ id: "Example Config", enabled: true }] },
        /plugin id "Example Config" is invalid/,
      ],
      [
        "detached result without kinds",
        {
          ...valid,
          policy: { detachedResults: [{ pluginId: "example.config", subjectKinds: [] }] },
        },
        /must list non-empty subject kinds/,
      ],
      ["unknown field", { ...valid, extra: true }, /distribution has unknown field extra/],
      ["bad semver", { ...valid, version: "1" }, /version "1" is not valid semver/],
      ["not an object", "borg.desktop", /definition must be an object/],
    ];
    for (const [, candidate, message] of cases) {
      expect(
        rejectionKernel(candidate as Distribution, [configSource()]),
        String(message),
      ).toThrow(message);
    }
    expect(rejectionKernel({ ...valid, id: "Not An Id" } as Distribution, [configSource()])).toThrow(
      /^Distribution Not An Id@0\.1\.0 cannot run on this kernel:/,
    );
  });

  it("activates only declared plugins, honors enabled: false, and resolves unqualified completions from distribution model defaults", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-distribution-"));
    let decoyContext: PluginContext | undefined;
    const optionalActivate = vi.fn();
    const extraActivate = vi.fn();
    kernel = createKernel({
      plugins: [
        sourceFor({
          id: "example.extra",
          version: "0.1.0",
          engines: { borg: "^0.1.0" },
          permissions: [],
          contributes: {},
          activate: extraActivate,
        }),
        configSource(),
        sourceFor({
          id: "example.optional",
          version: "0.1.0",
          engines: { borg: "^0.1.0" },
          permissions: [],
          contributes: {},
          activate: optionalActivate,
        }),
        secretSource(),
        sourceFor({
          id: "example.decoy",
          version: "0.1.0",
          engines: { borg: "^0.1.0" },
          permissions: ["models.register", "models.complete", "executions.manage"],
          contributes: { kinds: ["llmProvider"] },
          activate(context) {
            decoyContext = context;
            context.models.registerProvider({
              id: "example.decoy",
              models: ["other"],
              egress: {
                kind: "remote",
                capacity: "internal",
                destination: "https://models.test.invalid/v1/generate",
              },
              async complete(_request, permit) {
                await permit.commit();
                return {
                  content: "from-decoy",
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
              },
            });
          },
        }),
        sourceFor({
          id: "example.llm",
          version: "0.1.0",
          engines: { borg: "^0.1.0" },
          permissions: ["models.register"],
          contributes: { kinds: ["llmProvider"] },
          activate(context) {
            context.models.registerProvider({
              id: "example.llm",
              models: ["scripted"],
              egress: {
                kind: "remote",
                capacity: "internal",
                destination: "https://models.test.invalid/v1/generate",
              },
              async complete(_request, permit) {
                await permit.commit();
                return {
                  content: "from-distribution",
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
              },
            });
          },
        }),
      ],
      distribution: minimalDistribution,
      host: { dataDirectory },
      resolveSecretStore: async () => "example.secrets",
    });
    await kernel.start();

    expect(extraActivate).not.toHaveBeenCalled();
    expect(optionalActivate).not.toHaveBeenCalled();
    expect(kernel.plugins.getActivePluginIds()).toEqual([
      "example.config",
      "example.secrets",
      "example.decoy",
      "example.llm",
    ]);
    expect(kernel.plugins.isActive("example.optional")).toBe(false);
    expect(kernel.plugins.isActive("example.extra")).toBe(false);
    expect(kernel.plugins.getRecords()).toContainEqual(
      expect.objectContaining({ id: "example.optional", status: "disabled" }),
    );
    expect(kernel.plugins.listCatalog()).toContainEqual(
      expect.objectContaining({
        id: "example.optional",
        status: "disabled",
        enabled: false,
      }),
    );

    // Registered first, so only the distribution's defaults.models can pick example.llm
    // for a completion that names no provider or model.
    const context = decoyContext;
    expect(context).toBeDefined();
    const execution = await context!.executions.bind({
      mode: "root",
      subject: { kind: "distribution-test", id: "fallback" },
      classification: "internal",
      provenance: { kind: "plugin", id: "example.decoy" },
    });
    const completion = await context!.models.complete({
      executionId: execution.id,
      operationKey: modelOperationKeySchema.parse("distribution/fallback/model/0"),
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(completion).toMatchObject({
      providerId: "example.llm",
      modelId: "scripted",
      content: "from-distribution",
    });
  });

  it("uses policy.detachedResults for execution result flow", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-distribution-"));
    const store = new MemoryConfigStore();
    let probeContext: PluginContext | undefined;
    kernel = createKernel({
      plugins: [
        configSource("example.config", store),
        secretSource(),
        sourceFor({
          id: "example.probe",
          version: "0.1.0",
          engines: { borg: "^0.1.0" },
          permissions: ["executions.manage"],
          contributes: {},
          activate(context) {
            probeContext = context;
          },
        }),
      ],
      distribution: defineDistribution({
        id: "example.policy",
        name: "Policy",
        version: "0.1.0",
        kernel: "^0.1.0",
        plugins: ["example.config", "example.secrets", "example.probe"],
        policy: {
          detachedResults: [
            { pluginId: "example.probe", subjectKinds: ["probe-detached"] },
          ],
        },
      }),
      host: { dataDirectory },
      resolveSecretStore: async () => "example.secrets",
    });
    await kernel.start();

    const bind = (kind: string) =>
      probeContext!.executions.bind({
        mode: "root",
        subject: { kind, id: "one" },
        classification: "internal",
        provenance: { kind: "plugin", id: "example.probe" },
      });
    const resultFlowOf = (id: string) => {
      const record = store.values
        .get("kernel.execution-security")
        ?.get(`contexts/${id}`);
      return (record as { resultFlow?: unknown } | undefined)?.resultFlow;
    };

    const detached = await bind("probe-detached");
    const merged = await bind("probe-other");
    expect(resultFlowOf(detached.id)).toBe("detached");
    expect(resultFlowOf(merged.id)).toBe("merge_to_parent");
  });
});
