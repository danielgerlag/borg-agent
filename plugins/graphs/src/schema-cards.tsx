import { For, Index, Show, createMemo, type Component } from "solid-js";
import { Button } from "@borg/ui-kit";
import { Plus, Trash2 } from "lucide-solid";
import {
  emptyFieldCard,
  fieldCardsToJsonSchema,
  jsonSchemaToFieldCards,
  type FieldType,
  type SchemaFieldCard,
  type UiWidget,
} from "./schema";

const fieldClass =
  "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelClass =
  "block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]";

const TYPE_OPTIONS: readonly { value: FieldType; label: string }[] = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "object", label: "Object" },
  { value: "array", label: "List" },
];

export interface SchemaCardEditorProps {
  readonly schema: unknown;
  readonly onChange: (schema: ReturnType<typeof fieldCardsToJsonSchema>) => void;
  readonly testId: string;
}

function widgetsFor(type: FieldType): readonly { value: UiWidget; label: string }[] {
  if (type === "string") {
    return [
      { value: "textarea", label: "Textarea" },
      { value: "code-editor", label: "Code editor" },
      { value: "password", label: "Password" },
      { value: "date", label: "Date" },
      { value: "color-picker", label: "Color picker" },
    ];
  }
  if (type === "number") {
    return [{ value: "slider", label: "Slider" }];
  }
  return [];
}

const SchemaCardEditor: Component<SchemaCardEditorProps> = (props) => {
  const cards = createMemo(() => jsonSchemaToFieldCards(props.schema));

  const replace = (next: SchemaFieldCard[]): void => {
    props.onChange(fieldCardsToJsonSchema(next));
  };

  const update = (index: number, patch: Partial<SchemaFieldCard>): void => {
    replace(cards().map((card, cardIndex) => (cardIndex === index ? { ...card, ...patch } : card)));
  };

  return (
    <div class="grid gap-2" data-testid={props.testId}>
      <Index each={cards()}>
        {(card, index) => (
          <div class="rounded-xl border border-[var(--border)] bg-[var(--background)] p-2.5">
            <div class="flex items-start gap-2">
              <label class={`${labelClass} min-w-0 flex-1`}>
                Name
                <input
                  value={card().name}
                  onInput={(event) =>
                    update(index, { name: event.currentTarget.value })
                  }
                  class={fieldClass}
                />
              </label>
              <label class={`${labelClass} w-28 shrink-0`}>
                Type
                <select
                  value={card().type}
                  onChange={(event) => {
                    const type = event.currentTarget.value;
                    if (
                      type !== "string" &&
                      type !== "number" &&
                      type !== "boolean" &&
                      type !== "object" &&
                      type !== "array"
                    ) {
                      return;
                    }
                    const { xUi: _removed, ...rest } = card();
                    replace(
                      cards().map((item, cardIndex) =>
                        cardIndex === index ? { ...rest, type } : item,
                      ),
                    );
                  }}
                  class={fieldClass}
                >
                  <For each={TYPE_OPTIONS}>
                    {(option) => (
                      <option value={option.value}>{option.label}</option>
                    )}
                  </For>
                </select>
              </label>
              <button
                type="button"
                class="mt-5 rounded p-1 text-[var(--text-subtle)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                aria-label={`Remove field ${card().name}`}
                onClick={() =>
                  replace(cards().filter((_, cardIndex) => cardIndex !== index))
                }
              >
                <Trash2 aria-hidden="true" size={12} />
              </button>
            </div>
            <label class={`${labelClass} mt-2`}>
              Description
              <input
                value={card().description}
                onInput={(event) =>
                  update(index, { description: event.currentTarget.value })
                }
                class={fieldClass}
              />
            </label>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <label class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={card().required}
                  onChange={(event) =>
                    update(index, { required: event.currentTarget.checked })
                  }
                />
                Required
              </label>
              <label class={labelClass}>
                Default
                <Show
                  when={card().type === "boolean"}
                  fallback={
                    <input
                      type={card().type === "number" ? "number" : "text"}
                      value={card().defaultValue}
                      onInput={(event) =>
                        update(index, {
                          defaultValue: event.currentTarget.value,
                        })
                      }
                      class={fieldClass}
                    />
                  }
                >
                  <select
                    value={card().defaultValue || "false"}
                    onChange={(event) =>
                      update(index, {
                        defaultValue: event.currentTarget.value,
                      })
                    }
                    class={fieldClass}
                  >
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                </Show>
              </label>
            </div>
            <label class={`${labelClass} mt-2`}>
              Allowed values
              <input
                value={card().enumValues.join(", ")}
                placeholder="one, two, three"
                onInput={(event) =>
                  update(index, {
                    enumValues: event.currentTarget.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                class={fieldClass}
              />
            </label>
            <Show when={widgetsFor(card().type).length > 0}>
              <label class={`${labelClass} mt-2`}>
                Widget
                <select
                  value={card().xUi?.widget ?? ""}
                  onChange={(event) => {
                    const widget = event.currentTarget.value;
                    if (!widget) {
                      const { xUi: _removed, ...rest } = card();
                      replace(
                        cards().map((item, cardIndex) =>
                          cardIndex === index ? rest : item,
                        ),
                      );
                      return;
                    }
                    const parsed = widgetsFor(card().type).find(
                      (item) => item.value === widget,
                    )?.value;
                    if (!parsed) {
                      return;
                    }
                    update(index, {
                      xUi: { ...card().xUi, widget: parsed },
                    });
                  }}
                  class={fieldClass}
                >
                  <option value="">Default</option>
                  <For each={widgetsFor(card().type)}>
                    {(item) => <option value={item.value}>{item.label}</option>}
                  </For>
                </select>
              </label>
            </Show>
            <Show
              when={
                card().xUi?.widget === "textarea" ||
                card().xUi?.widget === "code-editor"
              }
            >
              <label class={`${labelClass} mt-2`}>
                Rows
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={card().xUi?.rows ?? ""}
                  onInput={(event) => {
                    const rows = Number(event.currentTarget.value);
                    const widget = card().xUi?.widget;
                    update(index, {
                      xUi: {
                        ...card().xUi,
                        ...(widget ? { widget } : {}),
                        ...(Number.isFinite(rows) && rows > 0 ? { rows } : {}),
                      },
                    });
                  }}
                  class={fieldClass}
                />
              </label>
            </Show>
            <Show when={card().xUi?.widget === "slider"}>
              <label class={`${labelClass} mt-2`}>
                Step
                <input
                  type="number"
                  min={0}
                  value={card().xUi?.step ?? ""}
                  onInput={(event) => {
                    const step = Number(event.currentTarget.value);
                    update(index, {
                      xUi: {
                        ...card().xUi,
                        widget: "slider",
                        ...(Number.isFinite(step) ? { step } : {}),
                      },
                    });
                  }}
                  class={fieldClass}
                />
              </label>
            </Show>
          </div>
        )}
      </Index>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        class="w-full"
        onClick={() => replace([...cards(), emptyFieldCard(cards().length)])}
      >
        <Plus aria-hidden="true" size={14} />
        Add field
      </Button>
    </div>
  );
};

export default SchemaCardEditor;
