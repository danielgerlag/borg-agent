/**
 * Design sessions stored under the plugin. Each design keeps its scene and transcript.
 */

import { randomUUID } from "node:crypto";
import type { JsonValue } from "@borg-agent/plugin-sdk";
import { z } from "@borg-agent/plugin-sdk";
import type { Body } from "./domain.js";
import { designerPersonaId, sceneSchema } from "./contract.js";

export const newDesignTitle = "New design";

const turnSchema = z
  .object({
    role: z.enum(["user", "designer"]),
    text: z.string().min(1),
  })
  .strict();

const designSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(48),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    revision: z.number().int().positive(),
    personaId: z.string().min(1),
    scene: sceneSchema,
    reply: z.string(),
    turns: z.array(turnSchema),
  })
  .strict();

const catalogSchema = z
  .object({
    currentId: z.string().uuid(),
    designs: z.array(designSchema).min(1),
  })
  .strict();

const legacyJobSchema = z
  .object({
    revision: z.number().int().positive(),
    personaId: z.string().min(1),
    sessionId: z.string().uuid(),
    scene: sceneSchema,
    reply: z.string(),
    turns: z.array(turnSchema),
  })
  .strict();

export type Job = z.output<typeof designSchema>;
type Catalog = z.output<typeof catalogSchema>;

export interface JobStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}

export interface JobSession {
  readonly job: Job;
  commit(next: Job): void;
}

export interface DesignSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly solids: number;
}

export interface JobWriter {
  read(): Promise<Job>;
  get(designId: string): Promise<Job>;
  list(): Promise<readonly DesignSummary[]>;
  run<T>(operation: (session: JobSession) => Promise<T>): Promise<T>;
  edit<T>(designId: string, operation: (session: JobSession) => Promise<T>): Promise<T>;
  create(): Promise<Job>;
  open(designId: string): Promise<Job>;
  remove(designId: string): Promise<Job>;
}

const JOB_KEY = "job";

export function designTitle(current: string, text: string): string {
  if (current !== newDesignTitle) {
    return current;
  }
  const next = text.trim().slice(0, 48);
  return next.length > 0 ? next : current;
}

export function readCatalog(stored: unknown): Catalog {
  const stripped = stripShopRun(stored);
  const catalog = catalogSchema.safeParse(stripped);
  if (catalog.success) {
    return seal(catalog.data);
  }
  const legacy = legacyJobSchema.safeParse(stripped);
  if (!legacy.success) {
    throw new Error("Print bench job is corrupt");
  }
  return seal(migrate(legacy.data));
}

function stripShopRun(stored: unknown): unknown {
  const record = z.record(z.string(), z.unknown()).safeParse(stored);
  if (!record.success) {
    return stored;
  }
  if (Array.isArray(record.data.designs)) {
    return {
      ...record.data,
      designs: record.data.designs.map((design) => {
        const body = z.record(z.string(), z.unknown()).safeParse(design);
        return body.success ? dropRun(body.data) : design;
      }),
    };
  }
  if ("sessionId" in record.data) {
    return dropRun(record.data);
  }
  return stored;
}

function dropRun(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value };
  delete next.machine;
  delete next.quoteSent;
  next.personaId = designerPersonaId;
  return next;
}

function migrate(job: z.output<typeof legacyJobSchema>): Catalog {
  const now = new Date().toISOString();
  const firstAsk = job.turns.find((turn) => turn.role === "user")?.text ?? "";
  const design = designSchema.parse({
    id: job.sessionId,
    title: designTitle(newDesignTitle, firstAsk),
    createdAt: now,
    updatedAt: now,
    revision: job.revision,
    personaId: designerPersonaId,
    scene: job.scene,
    reply: job.reply,
    turns: job.turns,
  });
  return { currentId: design.id, designs: [design] };
}

function seal(catalog: Catalog): Catalog {
  const ids = new Set<string>();
  for (const design of catalog.designs) {
    if (ids.has(design.id)) {
      throw new Error("Print bench job is corrupt");
    }
    ids.add(design.id);
  }
  if (!ids.has(catalog.currentId)) {
    throw new Error("Print bench job is corrupt");
  }
  return catalog;
}

function toJson(catalog: Catalog): JsonValue {
  return JSON.parse(JSON.stringify(catalog)) as JsonValue;
}

function currentDesign(catalog: Catalog): Job {
  const design = catalog.designs.find((item) => item.id === catalog.currentId);
  if (!design) {
    throw new Error("Print bench job is corrupt");
  }
  return design;
}

export function seed(now = new Date().toISOString()): Job {
  return {
    id: randomUUID(),
    title: newDesignTitle,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    personaId: designerPersonaId,
    scene: { bodies: [], selectedId: null },
    reply: "",
    turns: [],
  };
}

export function withScene(job: Job, scene: Job["scene"], reply = job.reply): Job {
  if (sameBodies(job.scene.bodies, scene.bodies)) {
    if (job.scene.selectedId === scene.selectedId && job.reply === reply) {
      return job;
    }
    return { ...job, scene, reply };
  }
  return {
    ...job,
    revision: job.revision + 1,
    scene,
    reply,
  };
}

function sameBodies(left: readonly Body[], right: readonly Body[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summaries(catalog: Catalog): readonly DesignSummary[] {
  return catalog.designs
    .map((design) => ({
      id: design.id,
      title: design.title,
      updatedAt: design.updatedAt,
      solids: design.scene.bodies.length,
    }))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title),
    );
}

export function createJobWriter(store: JobStore): JobWriter {
  let tail = Promise.resolve();
  let memory: Catalog | undefined;

  async function load(): Promise<Catalog> {
    if (memory) {
      return memory;
    }
    const stored = await store.get(JOB_KEY);
    if (stored === undefined) {
      const design = seed();
      memory = seal({ currentId: design.id, designs: [design] });
      await store.set(JOB_KEY, toJson(memory));
      return memory;
    }
    const migrated = !catalogSchema.safeParse(stored).success;
    memory = readCatalog(stored);
    if (migrated) {
      await store.set(JOB_KEY, toJson(memory));
    }
    return memory;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function save(catalog: Catalog): Promise<void> {
    memory = seal(catalogSchema.parse(catalog));
    await store.set(JOB_KEY, toJson(memory));
  }

  function replace(catalog: Catalog, designId: string, next: Job): Catalog {
    return {
      currentId: catalog.currentId,
      designs: catalog.designs.map((item) => (item.id === designId ? next : item)),
    };
  }

  async function editDesign<T>(
    designId: string,
    operation: (session: JobSession) => Promise<T>,
  ): Promise<T> {
    const catalog = await load();
    const job = catalog.designs.find((item) => item.id === designId);
    if (!job) {
      throw new Error(`Design ${designId} is unavailable`);
    }
    let next = job;
    let committed = false;
    const result = await operation({
      job,
      commit(value) {
        next = designSchema.parse({
          ...value,
          id: job.id,
          createdAt: job.createdAt,
          updatedAt: new Date().toISOString(),
        });
        committed = true;
      },
    });
    if (committed) {
      await save(replace(catalog, job.id, next));
    }
    return result;
  }

  return {
    // Stay off the writer tail so the bench can refresh during a designer turn.
    read: async () => currentDesign(await load()),
    get: async (designId) => {
      const design = (await load()).designs.find((item) => item.id === designId);
      if (!design) {
        throw new Error(`Design ${designId} is unavailable`);
      }
      return design;
    },
    list: async () => summaries(await load()),
    run(operation) {
      return enqueue(async () => editDesign(currentDesign(await load()).id, operation));
    },
    edit(designId, operation) {
      return enqueue(() => editDesign(designId, operation));
    },
    create() {
      return enqueue(async () => {
        const catalog = await load();
        const design = seed();
        await save({ currentId: design.id, designs: [design, ...catalog.designs] });
        return design;
      });
    },
    open(designId) {
      return enqueue(async () => {
        const catalog = await load();
        const design = catalog.designs.find((item) => item.id === designId);
        if (!design) {
          throw new Error(`Design ${designId} is unavailable`);
        }
        if (catalog.currentId !== designId) {
          await save({ ...catalog, currentId: designId });
        }
        return design;
      });
    },
    remove(designId) {
      return enqueue(async () => {
        const catalog = await load();
        const remaining = catalog.designs.filter((item) => item.id !== designId);
        if (remaining.length === catalog.designs.length) {
          throw new Error(`Design ${designId} is unavailable`);
        }
        let designs = remaining;
        let currentId = catalog.currentId;
        if (designs.length === 0) {
          const design = seed();
          designs = [design];
          currentId = design.id;
        } else if (currentId === designId) {
          const newest = [...designs].sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title),
          )[0];
          if (!newest) {
            throw new Error("Print bench job is corrupt");
          }
          currentId = newest.id;
        }
        await save({ currentId, designs });
        return currentDesign(memory ?? { currentId, designs });
      });
    },
  };
}
