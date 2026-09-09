import type { GraphNode } from "@borg/contracts";
import { Show, type Component } from "solid-js";
import FieldRenderer, { type InspectorCatalog } from "./field-renderer";
import { kindDescriptor } from "./kind-registry";

const fieldClass =
  "mt-1.5 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--text)] outline-none focus:border-[var(--accent)]";

export interface NodeInspectorProps {
  readonly node: GraphNode;
  readonly configText: string;
  readonly configError: string;
  readonly catalog: InspectorCatalog;
  readonly onConfigObject: (config: GraphNode["config"]) => void;
  readonly onConfigText: (text: string) => void;
}

const NodeInspector: Component<NodeInspectorProps> = (props) => {
  const descriptor = () => kindDescriptor(props.node.kind);
  return (
    <div class="mt-4 grid gap-3">
      <Show when={props.node.kind === "manual"}>
        <p class="text-xs leading-5 text-[var(--text-subtle)]">
          This trigger starts the graph. Consumers fill Graph inputs when you
          click Run.
        </p>
      </Show>
      <Show when={(descriptor()?.fields.length ?? 0) > 0}>
        <FieldRenderer
          specs={descriptor()?.fields ?? []}
          value={props.node.config}
          catalog={props.catalog}
          onChange={props.onConfigObject}
        />
      </Show>
      <label class="block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]">
        Config JSON
        <textarea
          value={props.configText}
          rows={9}
          spellcheck={false}
          onInput={(event) => props.onConfigText(event.currentTarget.value)}
          class={fieldClass}
          classList={{
            "border-[var(--danger)]": props.configError.length > 0,
          }}
          data-testid="graph-node-config"
        />
      </label>
      <Show when={props.configError.length > 0}>
        <p class="text-xs text-[var(--danger)]" role="alert">
          {props.configError}
        </p>
      </Show>
    </div>
  );
};

export default NodeInspector;
