import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// The bus wire surface is every command and event definition that ships in
// @borg/contracts or in a plugin's `./contract` subpath. This test snapshots
// each id and timeout plus a SHA-256 of the input- and output-side JSON Schema
// of every payload, and the same digest for every exported schema (tool inputs
// and outputs included). Moving a definition between packages must leave
// wire-contract.snapshot.txt byte-identical.

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

interface PackageJson {
  readonly name: string;
  readonly main?: string;
  readonly exports?: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
}

function readPackage(directory: string): PackageJson {
  return JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  ) as PackageJson;
}

function runtimeTarget(
  target: string | Readonly<Record<string, string>>,
): string {
  const resolved = typeof target === "string" ? target : target.default;
  if (!resolved) {
    throw new Error("Export target has no default condition");
  }
  return resolved;
}

function contractModules(): readonly { readonly specifier: string; readonly file: string }[] {
  const modules: { specifier: string; file: string }[] = [];
  const contractsDirectory = path.join(projectRoot, "packages/contracts");
  const contracts = readPackage(contractsDirectory);
  if (contracts.exports) {
    for (const [subpath, target] of Object.entries(contracts.exports)) {
      modules.push({
        specifier: path.posix.join(contracts.name, subpath),
        file: path.join(contractsDirectory, runtimeTarget(target)),
      });
    }
  } else {
    modules.push({
      specifier: contracts.name,
      file: path.join(contractsDirectory, contracts.main ?? "index.js"),
    });
  }
  const pluginsDirectory = path.join(projectRoot, "plugins");
  for (const entry of readdirSync(pluginsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(pluginsDirectory, entry.name);
    const pluginPackage = readPackage(directory);
    const target = pluginPackage.exports?.["./contract"];
    if (target) {
      modules.push({
        specifier: `${pluginPackage.name}/contract`,
        file: path.join(directory, runtimeTarget(target)),
      });
    }
  }
  return modules.sort((left, right) => left.specifier.localeCompare(right.specifier));
}

function isSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function schemaDigest(schema: z.ZodType): string {
  const json = JSON.stringify([
    z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }),
  ]);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function wireLine(
  name: string,
  value: unknown,
): { readonly key: string; readonly line: string } | undefined {
  if (isSchema(value)) {
    return { key: `schema ${name}`, line: `schema ${name} ${schemaDigest(value)}` };
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") {
    return undefined;
  }
  if (isSchema(candidate.input) && isSchema(candidate.output)) {
    const timeout = typeof candidate.timeoutMs === "number" ? candidate.timeoutMs : "-";
    return {
      key: `command ${candidate.id}`,
      line: `command ${candidate.id} timeout=${timeout} input=${schemaDigest(candidate.input)} output=${schemaDigest(candidate.output)}`,
    };
  }
  if (isSchema(candidate.payload)) {
    return {
      key: `event ${candidate.id}`,
      line: `event ${candidate.id} payload=${schemaDigest(candidate.payload)}`,
    };
  }
  return undefined;
}

async function collectWireSurface(): Promise<readonly string[]> {
  const entries = new Map<string, { readonly line: string; readonly definition: unknown }>();
  for (const module of contractModules()) {
    const exports = (await import(module.file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      const wire = wireLine(name, value);
      if (!wire) {
        continue;
      }
      const existing = entries.get(wire.key);
      if (existing && existing.definition !== value) {
        throw new Error(`${wire.key} is defined twice (again as ${module.specifier} ${name})`);
      }
      entries.set(wire.key, { line: wire.line, definition: value });
    }
  }
  return [...entries.values()].map(({ line }) => line).sort();
}

describe("bus wire surface", () => {
  it("keeps every command and event id, timeout, and schema unchanged", async () => {
    const surface = await collectWireSurface();
    expect({
      commands: surface.filter((line) => line.startsWith("command ")).length,
      events: surface.filter((line) => line.startsWith("event ")).length,
    }).toEqual({ commands: 93, events: 24 });
    await expect(`${surface.join("\n")}\n`).toMatchFileSnapshot(
      "./wire-contract.snapshot.txt",
    );
  });
});
