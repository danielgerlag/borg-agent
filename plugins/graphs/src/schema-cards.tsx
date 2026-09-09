import { Index, Show, createMemo, type Component } from "solid-js";
import { Button, Checkbox, Select, TextField } from "@borg/ui-kit";
import { Plus, Trash2 } from "lucide-solid";
import {
  emptyFieldCard,
  fieldCardsToJsonSchema,
  jsonSchemaToFieldCards,
  type FieldType,
  type SchemaFieldCard,
  type UiWidget,
} from "./schema";

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
              <TextField
                class="min-w-0 flex-1"
                label="Name"
                value={card().name}
                data-testid={`graph-schema-field-name-${index}`}
                onChange={(value) => update(index, { name: value })}
                size="sm"
              />
              <Select
                class="w-28 shrink-0"
                label="Type"
                value={card().type}
                onChange={(type) => {
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
                options={[...TYPE_OPTIONS]}
                size="sm"
              />
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
            <TextField
              class="mt-2"
              label="Description"
              value={card().description}
              onChange={(value) =>
                update(index, { description: value })
              }
              size="sm"
            />
            <div class="mt-2 grid grid-cols-2 gap-2">
              <Checkbox
                checked={card().required}
                onChange={(checked) =>
                  update(index, { required: checked })
                }
                label="Required"
              />
              <Show
                when={card().type === "boolean"}
                fallback={
                  <TextField
                    label="Default"
                    type={card().type === "number" ? "number" : "text"}
                    value={card().defaultValue}
                    onChange={(value) =>
                      update(index, {
                        defaultValue: value,
                      })
                    }
                    size="sm"
                  />
                }
              >
                <Select
                  label="Default"
                  value={card().defaultValue || "false"}
                  onChange={(value) =>
                    update(index, {
                      defaultValue: value,
                    })
                  }
                  options={[
                    { value: "false", label: "false" },
                    { value: "true", label: "true" },
                  ]}
                  size="sm"
                />
              </Show>
            </div>
            <TextField
              class="mt-2"
              label="Allowed values"
              value={card().enumValues.join(", ")}
              placeholder="one, two, three"
              onChange={(value) =>
                update(index, {
                  enumValues: value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
              size="sm"
            />
            <Show when={widgetsFor(card().type).length > 0}>
              <Select
                class="mt-2"
                label="Widget"
                value={card().xUi?.widget ?? ""}
                onChange={(widget) => {
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
                options={[
                  { value: "", label: "Default" },
                  ...widgetsFor(card().type),
                ]}
                size="sm"
              />
            </Show>
            <Show
              when={
                card().xUi?.widget === "textarea" ||
                card().xUi?.widget === "code-editor"
              }
            >
              <TextField
                class="mt-2"
                label="Rows"
                type="number"
                min={1}
                max={50}
                value={String(card().xUi?.rows ?? "")}
                onChange={(value) => {
                  const rows = Number(value);
                  const widget = card().xUi?.widget;
                  update(index, {
                    xUi: {
                      ...card().xUi,
                      ...(widget ? { widget } : {}),
                      ...(Number.isFinite(rows) && rows > 0 ? { rows } : {}),
                    },
                  });
                }}
                size="sm"
              />
            </Show>
            <Show when={card().xUi?.widget === "slider"}>
              <TextField
                class="mt-2"
                label="Step"
                type="number"
                min={0}
                value={String(card().xUi?.step ?? "")}
                onChange={(value) => {
                  const step = Number(value);
                  update(index, {
                    xUi: {
                      ...card().xUi,
                      widget: "slider",
                      ...(Number.isFinite(step) ? { step } : {}),
                    },
                  });
                }}
                size="sm"
              />
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
