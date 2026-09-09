import { graphValueMapSchema, type GraphNode, type Persona } from "@borg/contracts";
import { Select, Switch, TextField } from "@borg/ui-kit";
import {
  For,
  Index,
  Show,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";
import {
  assignmentRows,
  choiceRows,
  configFromAssignmentRows,
  isExpressionString,
  type AssignmentRow,
  type ChoiceRow,
} from "./assignments";
import type { FieldSpec } from "./kind-registry";
import { isJsonObject } from "./schema";
import SchemaForm from "./schema-form";

const labelClass =
  "block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]";

export interface ToolCatalogItem {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface InspectorCatalog {
  readonly personas: readonly Persona[];
  readonly tools: readonly ToolCatalogItem[];
}

export interface FieldRendererProps {
  readonly specs: readonly FieldSpec[];
  readonly value: GraphNode["config"];
  readonly catalog: InspectorCatalog;
  readonly onChange: (next: GraphNode["config"]) => void;
}

function patch(
  current: GraphNode["config"],
  key: string,
  value: unknown,
): GraphNode["config"] {
  if (value === undefined) {
    const next = { ...current };
    delete next[key];
    return graphValueMapSchema.parse(next);
  }
  return graphValueMapSchema.parse({ ...current, [key]: value });
}

function visible(spec: FieldSpec, value: GraphNode["config"]): boolean {
  if (!spec.visibleWhen) {
    return true;
  }
  return value[spec.visibleWhen.key] === spec.visibleWhen.equals;
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

type DurationUnit = "ms" | "s" | "min";

function unitFor(ms: number): DurationUnit {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return "min";
  }
  if (ms >= 1_000 && ms % 1_000 === 0) {
    return "s";
  }
  return "ms";
}

function factor(unit: DurationUnit): number {
  if (unit === "min") {
    return 60_000;
  }
  if (unit === "s") {
    return 1_000;
  }
  return 1;
}

const DurationField: Component<{
  readonly value: unknown;
  readonly min?: number;
  readonly allowExpression?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: unknown) => void;
}> = (props) => {
  const expression = createMemo(() =>
    Boolean(props.allowExpression && isExpressionString(props.value)),
  );
  const ms = createMemo(() =>
    typeof props.value === "number" && Number.isFinite(props.value)
      ? props.value
      : 0,
  );
  const [unit, setUnit] = createSignal<DurationUnit>(unitFor(ms()));

  return (
    <Show
      when={!expression()}
      fallback={
        <TextField
          value={readString(props.value)}
          disabled={props.disabled}
          onChange={(value) => props.onChange(value)}
          class="mt-1"
          size="sm"
          inputClass="font-mono"
          placeholder="$vars.waitMs"
        />
      }
    >
      <div class="mt-1 flex gap-2">
        <TextField
          type="number"
          min={0}
          value={String(ms() / factor(unit()))}
          disabled={props.disabled}
          onChange={(value) => {
            const next = Number(value);
            const millis = Number.isFinite(next)
              ? Math.max(props.min ?? 0, Math.round(next * factor(unit())))
              : 0;
            props.onChange(millis);
          }}
          class="min-w-0 flex-1"
          size="sm"
        />
        <Select
          value={unit()}
          disabled={props.disabled}
          onChange={(next) => {
            if (next !== "ms" && next !== "s" && next !== "min") {
              return;
            }
            const displayed = ms() / factor(unit());
            setUnit(next);
            props.onChange(Math.round(displayed * factor(next)));
          }}
          options={[
            { value: "ms", label: "ms" },
            { value: "s", label: "s" },
            { value: "min", label: "min" },
          ]}
          class="w-20"
          size="sm"
        />
      </div>
    </Show>
  );
};

const FieldRenderer: Component<FieldRendererProps> = (props) => {
  const setKey = (key: string, value: unknown): void => {
    props.onChange(patch(props.value, key, value));
  };

  return (
    <div class="grid gap-3" data-testid="graph-node-fields">
      <For each={props.specs}>
        {(spec) => (
          <Show when={visible(spec, props.value)}>
            <div>
              <div class={labelClass}>
                {spec.label}
                {spec.required ? (
                  <span class="ml-0.5 text-[var(--danger)]">*</span>
                ) : null}
              </div>
              <Show when={spec.widget === "text"}>
                <Show
                  when={spec.multiline}
                  fallback={
                    <TextField
                      value={readString(props.value[spec.key])}
                      onChange={(value) => setKey(spec.key, value)}
                      class="mt-1"
                      size="sm"
                    />
                  }
                >
                  <TextField
                    value={readString(props.value[spec.key])}
                    rows={4}
                    onChange={(value) => setKey(spec.key, value)}
                    class="mt-1"
                    size="sm"
                  />
                </Show>
              </Show>
              <Show when={spec.widget === "number"}>
                <TextField
                  type="number"
                  min={spec.min}
                  value={
                    typeof props.value[spec.key] === "number"
                      ? String(props.value[spec.key])
                      : ""
                  }
                  onChange={(value) => {
                    const next = Number(value);
                    setKey(spec.key, Number.isFinite(next) ? next : value);
                  }}
                  class="mt-1"
                  size="sm"
                />
              </Show>
              <Show when={spec.widget === "select"}>
                <Select
                  value={readString(props.value[spec.key])}
                  onChange={(value) => setKey(spec.key, value)}
                  options={spec.options ?? []}
                  class="mt-1"
                  size="sm"
                />
              </Show>
              <Show when={spec.widget === "switch"}>
                <Switch
                  checked={Boolean(props.value[spec.key])}
                  onChange={(checked) => setKey(spec.key, checked)}
                  label={spec.label}
                  class="mt-1"
                />
              </Show>
              <Show when={spec.widget === "persona"}>
                <Select
                  value={readString(props.value[spec.key])}
                  onChange={(value) => setKey(spec.key, value)}
                  options={[
                    { value: "", label: "Select a persona…" },
                    ...props.catalog.personas.map((persona) => ({
                      value: persona.id,
                      label: persona.name,
                    })),
                  ]}
                  class="mt-1"
                  size="sm"
                />
              </Show>
              <Show when={spec.widget === "tool"}>
                <ToolPicker
                  value={readString(props.value[spec.key])}
                  tools={props.catalog.tools}
                  onChange={(toolId) => setKey(spec.key, toolId)}
                />
              </Show>
              <Show when={spec.widget === "duration"}>
                <DurationField
                  value={props.value[spec.key]}
                  onChange={(value) => setKey(spec.key, value)}
                  {...(spec.min !== undefined ? { min: spec.min } : {})}
                  {...(spec.allowExpression ? { allowExpression: true } : {})}
                />
              </Show>
              <Show when={spec.widget === "expression"}>
                <Show
                  when={spec.multiline}
                  fallback={
                    <TextField
                      value={readString(props.value[spec.key])}
                      placeholder="$vars.name"
                      onChange={(value) => setKey(spec.key, value)}
                      class="mt-1"
                      size="sm"
                      inputClass="font-mono"
                    />
                  }
                >
                  <TextField
                    value={readString(props.value[spec.key])}
                    rows={4}
                    placeholder="$input.query"
                    onChange={(value) => setKey(spec.key, value)}
                    class="mt-1"
                    size="sm"
                    inputClass="font-mono"
                  />
                </Show>
              </Show>
              <Show when={spec.widget === "assignments"}>
                <AssignmentEditor
                  value={props.value}
                  onChange={props.onChange}
                />
              </Show>
              <Show when={spec.widget === "choiceList"}>
                <ChoiceListEditor
                  value={props.value[spec.key]}
                  onChange={(choices) => setKey(spec.key, choices)}
                />
              </Show>
              <Show when={spec.widget === "toolArgs"}>
                <ToolArgsEditor
                  toolId={readString(props.value.toolId)}
                  value={props.value[spec.key]}
                  tools={props.catalog.tools}
                  onChange={(input) => setKey(spec.key, input)}
                />
              </Show>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
};

const ToolPicker: Component<{
  readonly value: string;
  readonly tools: readonly ToolCatalogItem[];
  readonly onChange: (toolId: string) => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) {
      return props.tools;
    }
    return props.tools.filter(
      (tool) =>
        tool.id.toLowerCase().includes(needle) ||
        tool.description.toLowerCase().includes(needle),
    );
  });
  return (
    <div class="mt-1 grid gap-1">
      <TextField
        value={query()}
        placeholder="Search tools…"
        onChange={setQuery}
        size="sm"
      />
      <Select
        value={props.value}
        onChange={props.onChange}
        options={[
          { value: "", label: "Select a tool…" },
          ...filtered().map((tool) => ({
            value: tool.id,
            label: tool.description
              ? `${tool.id} — ${tool.description}`
              : tool.id,
          })),
        ]}
        size="sm"
      />
    </div>
  );
};

const AssignmentEditor: Component<{
  readonly value: GraphNode["config"];
  readonly onChange: (next: GraphNode["config"]) => void;
}> = (props) => {
  const rows = createMemo(() => assignmentRows(props.value));
  const replace = (next: AssignmentRow[]): void => {
    props.onChange(configFromAssignmentRows(next));
  };
  return (
    <div class="mt-1 grid gap-2">
      <Index each={rows()}>
        {(row, index) => (
          <div class="flex gap-2">
            <TextField
              value={row().name}
              placeholder="name"
              data-testid={`graph-assignment-name-${index}`}
              onChange={(value) => {
                const next = [...rows()];
                next[index] = { ...row(), name: value };
                replace(next);
              }}
              class="min-w-0 flex-1"
              size="sm"
            />
            <TextField
              value={row().value}
              placeholder="value or $vars.x"
              data-testid={`graph-assignment-value-${index}`}
              onChange={(value) => {
                const next = [...rows()];
                next[index] = { ...row(), value };
                replace(next);
              }}
              class="min-w-0 flex-1"
              size="sm"
            />
            <button
              type="button"
              class="rounded px-2 text-[var(--text-subtle)] hover:text-[var(--danger)]"
              aria-label={`Remove assignment ${row().name}`}
              onClick={() =>
                replace(rows().filter((_, rowIndex) => rowIndex !== index))
              }
            >
              ✕
            </button>
          </div>
        )}
      </Index>
      <button
        type="button"
        class="rounded-lg border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]"
        onClick={() => replace([...rows(), { name: "", value: "" }])}
      >
        Add assignment
      </button>
    </div>
  );
};

const ChoiceListEditor: Component<{
  readonly value: unknown;
  readonly onChange: (choices: ChoiceRow[]) => void;
}> = (props) => {
  const rows = createMemo(() => choiceRows(props.value));
  return (
    <div class="mt-1 grid gap-2">
      <Index each={rows()}>
        {(row, index) => (
          <div class="flex gap-2">
            <TextField
              value={row().id}
              placeholder="id"
              onChange={(value) => {
                const next = [...rows()];
                next[index] = { ...row(), id: value };
                props.onChange(next);
              }}
              class="min-w-0 flex-1"
              size="sm"
            />
            <TextField
              value={row().label}
              placeholder="label"
              onChange={(value) => {
                const next = [...rows()];
                next[index] = { ...row(), label: value };
                props.onChange(next);
              }}
              class="min-w-0 flex-1"
              size="sm"
            />
            <button
              type="button"
              class="rounded px-2 text-[var(--text-subtle)] hover:text-[var(--danger)]"
              aria-label={`Remove choice ${row().id}`}
              onClick={() =>
                props.onChange(
                  rows().filter((_, rowIndex) => rowIndex !== index),
                )
              }
            >
              ✕
            </button>
          </div>
        )}
      </Index>
      <button
        type="button"
        class="rounded-lg border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]"
        onClick={() =>
          props.onChange([
            ...rows(),
            { id: `choice-${rows().length + 1}`, label: "" },
          ])
        }
      >
        Add choice
      </button>
    </div>
  );
};

const ToolArgsEditor: Component<{
  readonly toolId: string;
  readonly value: unknown;
  readonly tools: readonly ToolCatalogItem[];
  readonly onChange: (input: Record<string, unknown>) => void;
}> = (props) => {
  const tool = createMemo(() =>
    props.tools.find((item) => item.id === props.toolId),
  );
  const objectValue = createMemo((): Record<string, unknown> =>
    isJsonObject(props.value) ? props.value : {},
  );
  return (
    <Show
      when={tool()}
      fallback={
        <TextField
          value={
            isJsonObject(props.value)
              ? JSON.stringify(props.value, null, 2)
              : ""
          }
          rows={6}
          spellcheck={false}
          onChange={(value) => {
            try {
              const parsed: unknown = JSON.parse(value);
              if (isJsonObject(parsed)) {
                props.onChange(parsed);
              }
            } catch {
              /* wait for valid JSON */
            }
          }}
          class="mt-1"
          size="sm"
          inputClass="font-mono"
        />
      }
    >
      {(selected) => (
        <div class="mt-1">
          <SchemaForm
            schema={selected().inputSchema}
            value={objectValue()}
            onChange={props.onChange}
            testId="graph-tool-args"
          />
        </div>
      )}
    </Show>
  );
};

export default FieldRenderer;
