import { randomUUID } from "node:crypto";
import type { JsonValue } from "@borg-agent/plugin-sdk";
import { z } from "@borg-agent/plugin-sdk";
import type { Body } from "./domain.js";
import { designerPersonaId, sceneSchema } from "./contract.js";

const storedJobSchema = z
  .object({
    revision: z.number().int().positive(),
    personaId: z.string().min(1),
    sessionId: z.string().uuid(),
    scene: sceneSchema,
    reply: z.string(),
    machine: z.discriminatedUnion("status", [
      z.object({ status: z.literal("idle") }).strict(),
      z
        .object({
          status: z.literal("running"),
          revision: z.number().int(),
        })
        .strict(),
    ]),
    quoteSent: z
      .object({
        revision: z.number().int(),
        messageId: z.string().min(1),
        sentAt: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type Job = z.output<typeof storedJobSchema>;

export interface JobStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}

export interface JobSession {
  readonly job: Job;
  commit(next: Job): void;
}

export interface JobWriter {
  read(): Promise<Job>;
  run<T>(operation: (session: JobSession) => Promise<T>): Promise<T>;
}

const JOB_KEY = "job";

function toJson(job: Job): JsonValue {
  return JSON.parse(JSON.stringify(job)) as JsonValue;
}

export function createJobWriter(store: JobStore): JobWriter {
  let tail = Promise.resolve();
  let memory: Job | undefined;

  async function load(): Promise<Job> {
    if (memory) {
      return memory;
    }
    const stored = await store.get(JOB_KEY);
    if (stored === undefined) {
      memory = seed();
      await store.set(JOB_KEY, toJson(storedJobSchema.parse(memory)));
      return memory;
    }
    const parsed = storedJobSchema.safeParse(stored);
    if (!parsed.success) {
      throw new Error("Print bench job is corrupt");
    }
    memory = parsed.data;
    return memory;
  }

  return {
    // Stay off the writer tail so a quote approval can still refresh the bench.
    read: load,
    run(operation) {
      const run = tail.then(async () => {
        const job = await load();
        let next = job;
        let committed = false;
        const result = await operation({
          job,
          commit(value) {
            next = storedJobSchema.parse(value);
            committed = true;
          },
        });
        if (committed) {
          memory = next;
          await store.set(JOB_KEY, toJson(next));
        }
        return result;
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

export function seed(): Job {
  return {
    revision: 1,
    personaId: designerPersonaId,
    sessionId: randomUUID(),
    scene: { bodies: [], selectedId: null },
    reply: "",
    machine: { status: "idle" },
    quoteSent: null,
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
    quoteSent: null,
    machine: { status: "idle" },
  };
}

function sameBodies(left: readonly Body[], right: readonly Body[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
