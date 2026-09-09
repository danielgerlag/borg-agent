import type { GraphNode } from "@borg/contracts";
import { TextField } from "@borg/ui-kit";
import { Show, type Component } from "solid-js";
import FieldRenderer, { type InspectorCatalog } from "./field-renderer";
import { kindDescriptor } from "./kind-registry";

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
      <TextField
        label="Config JSON"
        value={props.configText}
        rows={9}
        spellcheck={false}
        onChange={props.onConfigText}
        size="sm"
        inputClass={
          props.configError.length > 0
            ? "font-mono text-[11px] leading-5 border-[var(--danger)]"
            : "font-mono text-[11px] leading-5"
        }
        data-testid="graph-node-config"
      />
      <Show when={props.configError.length > 0}>
        <p class="text-xs text-[var(--danger)]" role="alert">
          {props.configError}
        </p>
      </Show>
    </div>
  );
};

export default NodeInspector;
