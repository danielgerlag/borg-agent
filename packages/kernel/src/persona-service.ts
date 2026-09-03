import {
  personaIdSchema,
  personaSchema,
  type Persona,
} from "@borg/contracts";
import { z, type JsonValue } from "@borg/plugin-sdk";
import type { StoreFacade } from "./persistence";

const PERSONA_NAMESPACE = "system.personas";
const PERSONA_STATE_KEY = "state";
const DEFAULT_PERSONA_ID = "system/general";

const personaStateSchema = z
  .object({
    version: z.literal(1),
    defaultPersonaId: personaIdSchema,
    personas: z.array(personaSchema),
  })
  .strict();

type PersonaState = z.infer<typeof personaStateSchema>;

const bundledGeneralPersona = personaSchema.parse({
  id: DEFAULT_PERSONA_ID,
  name: "General",
  description: "General-purpose local assistant",
  instructions:
    "You are Borg, a careful local assistant. Be concise, use tools only when useful, and explain consequential actions.",
  preferredModels: ["borg.mock-llm:mock:scripted"],
  secondaryModels: [],
  allowedTools: ["*"],
  mcpServers: [],
  loopStrategy: "react",
  toolExecutionMode: "sequential-partial",
  skillIds: [],
  contextMapStrategy: "general",
  archived: false,
  bundled: true,
});

function freezePersona(persona: Persona): Persona {
  return deepFreeze(structuredClone(persona));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function normalizeState(candidate: unknown): PersonaState {
  const parsed = personaStateSchema.parse(
    candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      !("version" in candidate)
      ? { ...candidate, version: 1 }
      : candidate,
  );
  return {
    version: 1,
    defaultPersonaId: parsed.defaultPersonaId,
    personas: parsed.personas.map(freezePersona),
  };
}

export class PersonaService {
  #state: PersonaState | undefined;
  #writeQueue = Promise.resolve();

  constructor(readonly store: StoreFacade) {}

  async initialize(): Promise<void> {
    const stored = await this.store.get(PERSONA_NAMESPACE, PERSONA_STATE_KEY);
    if (stored === undefined) {
      this.#state = {
        version: 1,
        defaultPersonaId: DEFAULT_PERSONA_ID,
        personas: [freezePersona(bundledGeneralPersona)],
      };
      await this.#persistState(this.#state);
      return;
    }
    const parsed = normalizeState(stored);
    const personas = parsed.personas.map(freezePersona);
    if (!personas.some(({ id }) => id === DEFAULT_PERSONA_ID)) {
      personas.push(freezePersona(bundledGeneralPersona));
    }
    if (!personas.some(({ archived }) => !archived)) {
      const generalIndex = personas.findIndex(
        ({ id }) => id === DEFAULT_PERSONA_ID,
      );
      personas[generalIndex] = freezePersona({
        ...personas[generalIndex]!,
        archived: false,
      });
    }
    const defaultPersonaId = personas.some(
      ({ id, archived }) => id === parsed.defaultPersonaId && !archived,
    )
      ? parsed.defaultPersonaId
      : personas.find(({ archived }) => !archived)!.id;
    this.#state = { version: 1, defaultPersonaId, personas };
    await this.#persistState(this.#state);
  }

  get(personaId: string): Persona | undefined {
    return this.#requireState().personas.find(({ id }) => id === personaId);
  }

  list(includeArchived = false): readonly Persona[] {
    return this.#requireState()
      .personas.filter(({ archived }) => includeArchived || !archived)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getDefault(): Persona {
    const state = this.#requireState();
    return (
      state.personas.find(
        ({ id, archived }) => id === state.defaultPersonaId && !archived,
      ) ??
      state.personas.find(
        ({ id, archived }) => id === DEFAULT_PERSONA_ID && !archived,
      ) ??
      (() => {
        throw new Error("No active persona is available");
      })()
    );
  }

  async setDefault(personaId: string): Promise<Persona> {
    personaIdSchema.parse(personaId);
    return this.#mutate((state) => {
      const persona = state.personas.find(
        ({ id, archived }) => id === personaId && !archived,
      );
      if (!persona) {
        throw new Error(`Persona ${personaId} is unavailable`);
      }
      state.defaultPersonaId = personaId;
      return persona;
    });
  }

  async create(candidate: unknown): Promise<Persona> {
    return this.#mutate((state) => {
      const persona = freezePersona(
        personaSchema.parse({
          ...(candidate as Record<string, unknown>),
          bundled: false,
        }),
      );
      if (state.personas.some(({ id }) => id === persona.id)) {
        throw new Error(`Persona ${persona.id} already exists`);
      }
      if (persona.id.startsWith("system/")) {
        throw new Error("Custom personas cannot use the system namespace");
      }
      state.personas.push(persona);
      return persona;
    });
  }

  async update(
    personaId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Persona> {
    personaIdSchema.parse(personaId);
    return this.#mutate((state) => {
      const index = state.personas.findIndex(({ id }) => id === personaId);
      const current = state.personas[index];
      if (!current) {
        throw new Error(`Persona ${personaId} is unavailable`);
      }
      if ("id" in patch || "bundled" in patch) {
        throw new Error("Persona identity and bundled status are immutable");
      }
      const updated = freezePersona(
        personaSchema.parse({ ...current, ...patch }),
      );
      const activeAlternatives = state.personas.filter(
        ({ id, archived }) => id !== personaId && !archived,
      );
      if (updated.archived && activeAlternatives.length === 0) {
        throw new Error("Cannot archive the last active persona");
      }
      state.personas[index] = updated;
      if (updated.archived && state.defaultPersonaId === updated.id) {
        state.defaultPersonaId = activeAlternatives[0]!.id;
      }
      return updated;
    });
  }

  async archive(personaId: string): Promise<void> {
    await this.update(personaId, { archived: true });
  }

  async #mutate<T>(mutation: (state: {
    version: 1;
    defaultPersonaId: string;
    personas: Persona[];
  }) => T): Promise<T> {
    let result: T | undefined;
    const operation = this.#writeQueue.then(async () => {
      const current = this.#requireState();
      const draft = {
        version: 1 as const,
        defaultPersonaId: current.defaultPersonaId,
        personas: [...current.personas],
      };
      result = mutation(draft);
      const next = normalizeState(draft);
      await this.#persistState(next);
      this.#state = next;
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return result as T;
  }

  async #persistState(state: PersonaState): Promise<void> {
    await this.store.set(
      PERSONA_NAMESPACE,
      PERSONA_STATE_KEY,
      asJsonValue(state),
    );
  }

  #requireState(): PersonaState {
    if (!this.#state) {
      throw new Error("Persona service is not initialized");
    }
    return this.#state;
  }
}

export { DEFAULT_PERSONA_ID };
