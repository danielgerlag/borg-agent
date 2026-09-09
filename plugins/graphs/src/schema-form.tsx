import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import {
  evaluateFieldCondition,
  isJsonObject,
  schemaHasProperties,
  type FieldCondition,
  type UiWidget,
} from "./schema";

const fieldClass =
  "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelClass =
  "block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]";

export interface SchemaFormProps {
  readonly schema: unknown;
  readonly value: Record<string, unknown>;
  readonly onChange: (value: Record<string, unknown>) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}

function asUiWidget(value: unknown): UiWidget | undefined {
  if (
    value === "textarea" ||
    value === "code-editor" ||
    value === "password" ||
    value === "date" ||
    value === "color-picker" ||
    value === "slider"
  ) {
    return value;
  }
  return undefined;
}

function readHint(property: Record<string, unknown>): {
  widget?: UiWidget;
  rows?: number;
  step?: number;
  condition?: FieldCondition;
  label?: string;
} {
  const raw = property["x-ui"];
  if (!isJsonObject(raw)) {
    return {};
  }
  const widget = asUiWidget(raw.widget);
  const condition = isJsonObject(raw.condition) && typeof raw.condition.field === "string"
    ? Object.hasOwn(raw.condition, "eq")
      ? { field: raw.condition.field, eq: raw.condition.eq }
      : { field: raw.condition.field }
    : undefined;
  return {
    ...(widget ? { widget } : {}),
    ...(typeof raw.rows === "number" ? { rows: raw.rows } : {}),
    ...(typeof raw.step === "number" ? { step: raw.step } : {}),
    ...(condition ? { condition } : {}),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
  };
}

function propertyEntries(
  schema: unknown,
): readonly { name: string; property: Record<string, unknown> }[] {
  if (!isJsonObject(schema) || !isJsonObject(schema.properties)) {
    return [];
  }
  return Object.entries(schema.properties).flatMap(([name, raw]) =>
    isJsonObject(raw) ? [{ name, property: raw }] : [],
  );
}

function coerceNumber(raw: string): unknown {
  if (raw === "") {
    return "";
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : raw;
}

const SchemaForm: Component<SchemaFormProps> = (props) => {
  const [jsonMode, setJsonMode] = createSignal(false);
  const [jsonText, setJsonText] = createSignal("");
  const [jsonError, setJsonError] = createSignal<string>();
  const entries = createMemo(() => propertyEntries(props.schema));
  const required = createMemo(() => {
    if (!isJsonObject(props.schema) || !Array.isArray(props.schema.required)) {
      return new Set<string>();
    }
    return new Set(
      props.schema.required.filter(
        (item): item is string => typeof item === "string",
      ),
    );
  });

  const setField = (name: string, value: unknown): void => {
    props.onChange({ ...props.value, [name]: value });
  };

  const renderControl = (
    name: string,
    property: Record<string, unknown>,
  ) => {
    const hint = readHint(property);
    const current = props.value[name];
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((item): item is string => typeof item === "string")
      : [];
    const widget = hint.widget;
    const disabled = props.disabled;

    if (widget === "textarea" || widget === "code-editor") {
      return (
        <textarea
          value={String(current ?? "")}
          rows={hint.rows ?? 4}
          disabled={disabled}
          onInput={(event) => setField(name, event.currentTarget.value)}
          class={fieldClass}
          classList={{ "font-mono": widget === "code-editor" }}
        />
      );
    }
    if (widget === "password") {
      return (
        <input
          type="password"
          value={String(current ?? "")}
          disabled={disabled}
          onInput={(event) => setField(name, event.currentTarget.value)}
          class={fieldClass}
        />
      );
    }
    if (widget === "date") {
      return (
        <input
          type="date"
          value={String(current ?? "")}
          disabled={disabled}
          onInput={(event) => setField(name, event.currentTarget.value)}
          class={fieldClass}
        />
      );
    }
    if (widget === "color-picker") {
      return (
        <input
          type="color"
          value={String(current ?? "#000000")}
          disabled={disabled}
          onInput={(event) => setField(name, event.currentTarget.value)}
          class="mt-1 h-8 w-12 cursor-pointer rounded border border-[var(--border)] bg-[var(--background)] p-1"
        />
      );
    }
    if (widget === "slider" && (property.type === "number" || property.type === "integer")) {
      const numeric = typeof current === "number" ? current : Number(property.minimum ?? 0);
      return (
        <div class="mt-1 flex items-center gap-2">
          <input
            type="range"
            min={typeof property.minimum === "number" ? property.minimum : 0}
            max={typeof property.maximum === "number" ? property.maximum : 100}
            step={hint.step ?? 1}
            value={numeric}
            disabled={disabled}
            onInput={(event) =>
              setField(name, Number(event.currentTarget.value))
            }
            class="flex-1"
          />
          <span class="min-w-8 text-right text-xs text-[var(--text)]">
            {numeric}
          </span>
        </div>
      );
    }
    if (enumValues.length > 0) {
      return (
        <select
          value={String(current ?? "")}
          disabled={disabled}
          onChange={(event) => setField(name, event.currentTarget.value)}
          class={fieldClass}
        >
          <option value="">—</option>
          <For each={enumValues}>
            {(item) => <option value={item}>{item}</option>}
          </For>
        </select>
      );
    }
    if (property.type === "boolean") {
      return (
        <label class="mt-1 flex items-center gap-2 text-xs text-[var(--text)]">
          <input
            type="checkbox"
            checked={Boolean(current)}
            disabled={disabled}
            onChange={(event) => setField(name, event.currentTarget.checked)}
          />
          {hint.label || name}
        </label>
      );
    }
    if (property.type === "number" || property.type === "integer") {
      return (
        <input
          type="number"
          value={current === undefined || current === "" ? "" : String(current)}
          min={typeof property.minimum === "number" ? property.minimum : undefined}
          max={typeof property.maximum === "number" ? property.maximum : undefined}
          disabled={disabled}
          onInput={(event) =>
            setField(name, coerceNumber(event.currentTarget.value))
          }
          class={fieldClass}
        />
      );
    }
    if (property.type === "object" || property.type === "array") {
      return (
        <textarea
          value={
            typeof current === "string"
              ? current
              : current === undefined
                ? ""
                : JSON.stringify(current, null, 2)
          }
          rows={4}
          disabled={disabled}
          spellcheck={false}
          onInput={(event) => {
            const text = event.currentTarget.value;
            try {
              setField(name, JSON.parse(text) as unknown);
            } catch {
              setField(name, text);
            }
          }}
          class={`${fieldClass} font-mono`}
        />
      );
    }
    return (
      <input
        type="text"
        value={String(current ?? "")}
        maxLength={
          typeof property.maxLength === "number" ? property.maxLength : undefined
        }
        disabled={disabled}
        onInput={(event) => setField(name, event.currentTarget.value)}
        class={fieldClass}
      />
    );
  };

  return (
    <div data-testid={props.testId}>
      <Show when={schemaHasProperties(props.schema)}>
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]">
            Fields
          </span>
          <button
            type="button"
            class="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
            onClick={() => {
              if (!jsonMode()) {
                setJsonText(JSON.stringify(props.value, null, 2));
                setJsonError(undefined);
              }
              setJsonMode(!jsonMode());
            }}
          >
            {jsonMode() ? "Form" : "JSON"}
          </button>
        </div>
      </Show>
      <Show when={jsonMode()}>
        <textarea
          value={jsonText()}
          rows={8}
          spellcheck={false}
          disabled={props.disabled}
          onInput={(event) => {
            const text = event.currentTarget.value;
            setJsonText(text);
            try {
              const parsed: unknown = JSON.parse(text);
              if (!isJsonObject(parsed)) {
                throw new Error("Value must be a JSON object.");
              }
              props.onChange(parsed);
              setJsonError(undefined);
            } catch (failure) {
              setJsonError(
                failure instanceof Error ? failure.message : String(failure),
              );
            }
          }}
          class={`${fieldClass} font-mono`}
        />
        <Show when={jsonError()}>
          {(message) => (
            <p class="mt-1 text-xs text-[var(--danger)]" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </Show>
      <Show when={!jsonMode()}>
        <div class="grid gap-3">
          <For each={entries()}>
            {(entry) => {
              const hint = readHint(entry.property);
              return (
                <Show
                  when={evaluateFieldCondition(hint.condition, props.value)}
                >
                  <label class={labelClass}>
                    {hint.label || entry.name}
                    {required().has(entry.name) ? (
                      <span class="ml-0.5 text-[var(--danger)]">*</span>
                    ) : null}
                    <Show when={entry.property.description}>
                      {(description) => (
                        <span class="ml-1 font-normal normal-case tracking-normal text-[var(--text-subtle)]">
                          {String(description())}
                        </span>
                      )}
                    </Show>
                    {renderControl(entry.name, entry.property)}
                  </label>
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default SchemaForm;
