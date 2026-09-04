import {
  MCP_APP_RENDERER_ID,
  mcpAppSnapshotSchema,
  mcpAppsCancelTool,
  mcpAppsInvokeTool,
  type McpAppRequestId,
  type McpAppSnapshot,
} from "@borg/contracts";
import {
  defineUiPlugin,
  type EmbeddedContentRendererProps,
} from "@borg/plugin-sdk";
import {
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import {
  bridgeEnvelope,
  createHostInitializeResult,
  createProxyUrl,
  hasEmptyParams,
  hardenAppHtml,
  isProxyReady,
  parseAppRpcRequest,
  parseBridgeEnvelope,
  parseCancelledParams,
  parseInitializeParams,
  parseToolCallParams,
  sandboxResourceReady,
} from "./proxy";

function requestKey(id: McpAppRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function rpcResult(id: McpAppRequestId, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: McpAppRequestId, code: number, message: string): object {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message: message.slice(0, 1_000) },
  };
}

export default defineUiPlugin<Component>({
  id: "borg.mcp-apps",
  activate(context) {
    const McpAppFrame: Component<EmbeddedContentRendererProps> = (props) => {
      const snapshot = createMemo<McpAppSnapshot | undefined>(() => {
        const parsed = mcpAppSnapshotSchema.safeParse(props.content.payload);
        return parsed.success ? parsed.data : undefined;
      });
      const [ready, setReady] = createSignal(false);
      const nonce = globalThis.crypto.randomUUID();
      const pending = new Map<
        string,
        {
          readonly appInstanceId: string;
          readonly invocationId: string;
        }
      >();
      let frame: HTMLIFrameElement | undefined;
      let active = true;
      let initialized = false;
      let proxyInitialized = false;

      const failBridge = (): void => {
        active = false;
        setReady(false);
        if (frame) {
          frame.src = "about:blank";
        }
      };

      const cancelInvocation = async (invocation: {
        readonly appInstanceId: string;
        readonly invocationId: string;
      }): Promise<boolean> => {
        try {
          const result = await context.bus.invoke(
            mcpAppsCancelTool,
            invocation,
          );
          return result.cancelled;
        } catch {
          return false;
        }
      };

      const post = (payload: unknown): void => {
        const app = snapshot();
        if (!app || !frame?.contentWindow || !active) {
          return;
        }
        frame.contentWindow.postMessage(
          bridgeEnvelope(app.appInstanceId, nonce, payload),
          "*",
        );
      };

      const sendInitialState = (app: McpAppSnapshot): void => {
        post({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: app.toolInput },
        });
        post({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: app.callResult,
        });
      };

      const handleRequest = async (
        app: McpAppSnapshot,
        request: ReturnType<typeof parseAppRpcRequest> & object,
      ): Promise<void> => {
        if (request.method === "ui/initialize" && request.id !== undefined) {
          const params = parseInitializeParams(request.params);
          if (!params || initialized) {
            post(rpcError(request.id, -32602, "Invalid initialize request"));
            return;
          }
          initialized = true;
          post(rpcResult(request.id, createHostInitializeResult(app, params.protocolVersion)));
          return;
        }
        if (!initialized) {
          if (request.id !== undefined) {
            post(rpcError(request.id, -32002, "MCP App is not initialized"));
          }
          return;
        }
        if (request.method === "ping" && request.id !== undefined) {
          post(
            hasEmptyParams(request.params)
              ? rpcResult(request.id, {})
              : rpcError(request.id, -32602, "Invalid ping request"),
          );
          return;
        }
        if (
          request.method === "ui/notifications/initialized" &&
          request.id === undefined &&
          hasEmptyParams(request.params) &&
          !ready()
        ) {
          setReady(true);
          sendInitialState(app);
          return;
        }
        if (!ready()) {
          if (request.id !== undefined) {
            post(rpcError(request.id, -32002, "MCP App is not ready"));
          }
          return;
        }
        if (request.method === "tools/list" && request.id !== undefined) {
          post(
            rpcResult(request.id, {
              tools: app.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            }),
          );
          return;
        }
        if (request.method === "tools/call" && request.id !== undefined) {
          const params = parseToolCallParams(request.params);
          if (!params) {
            post(rpcError(request.id, -32602, "Invalid tool call"));
            return;
          }
          const key = requestKey(request.id);
          const duplicate = pending.get(key);
          if (duplicate) {
            pending.delete(key);
            await cancelInvocation(duplicate);
            post(rpcError(request.id, -32600, "Duplicate request id"));
            return;
          }
          const invocationId = globalThis.crypto.randomUUID();
          pending.set(key, {
            appInstanceId: app.appInstanceId,
            invocationId,
          });
          try {
            const response = await context.bus.invoke(mcpAppsInvokeTool, {
              appInstanceId: app.appInstanceId,
              invocationId,
              requestId: request.id,
              toolName: params.name,
              arguments: params.arguments,
            });
            if (
              active &&
              pending.get(key)?.invocationId === invocationId
            ) {
              post(rpcResult(response.requestId, response.result));
            }
          } catch (error) {
            if (
              active &&
              pending.get(key)?.invocationId === invocationId
            ) {
              post(
                rpcError(
                  request.id,
                  -32603,
                  error instanceof Error
                    ? error.message
                    : "MCP App tool call failed",
                ),
              );
            }
          } finally {
            if (pending.get(key)?.invocationId === invocationId) {
              pending.delete(key);
            }
          }
          return;
        }
        if (
          request.method === "notifications/cancelled" &&
          request.id === undefined
        ) {
          const params = parseCancelledParams(request.params);
          if (!params) {
            return;
          }
          const key = requestKey(params.requestId);
          const invocation = pending.get(key);
          if (
            invocation &&
            (await cancelInvocation(invocation)) &&
            pending.get(key)?.invocationId === invocation.invocationId
          ) {
            pending.delete(key);
          }
          return;
        }
        if (request.id !== undefined) {
          post(rpcError(request.id, -32601, "Method not found"));
        }
      };

      const onMessage = (event: MessageEvent): void => {
        const app = snapshot();
        if (
          !app ||
          event.source !== frame?.contentWindow ||
          event.origin !== "null"
        ) {
          return;
        }
        const envelope = parseBridgeEnvelope(
          event.data,
          app.appInstanceId,
          nonce,
        );
        if (
          envelope &&
          isProxyReady(envelope.payload) &&
          !proxyInitialized
        ) {
          proxyInitialized = true;
          try {
            post(sandboxResourceReady(hardenAppHtml(app.html)));
          } catch {
            failBridge();
          }
          return;
        }
        const request = envelope
          ? parseAppRpcRequest(envelope.payload)
          : undefined;
        if (request) {
          void handleRequest(app, request).catch(failBridge);
        }
      };

      onMount(() => {
        const app = snapshot();
        globalThis.addEventListener("message", onMessage);
        if (app && frame) {
          frame.src = createProxyUrl({
            instanceId: app.appInstanceId,
            nonce,
            parentOrigin:
              globalThis.location.protocol === "file:"
                ? "null"
                : globalThis.location.origin,
          });
        }
      });

      onCleanup(() => {
        active = false;
        globalThis.removeEventListener("message", onMessage);
        if (frame) {
          frame.src = "about:blank";
        }
        for (const invocation of pending.values()) {
          void cancelInvocation(invocation);
        }
        pending.clear();
      });

      return (
        <Show
          when={snapshot()}
          fallback={
            <p
              class="rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-3 text-sm text-[var(--danger)]"
              role="alert"
              data-testid="mcp-app-invalid"
            >
              This MCP App snapshot is invalid.
            </p>
          }
        >
          {(app) => (
            <section
              class="overflow-hidden rounded-xl border border-[var(--border)] bg-white"
              data-testid="mcp-app"
              data-app-instance-id={app().appInstanceId}
              data-ready={ready() ? "true" : "false"}
            >
              <iframe
                ref={frame}
                class="block h-[22rem] w-full border-0"
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
                title={`MCP App ${app().sourceToolName}`}
                data-testid="mcp-app-frame"
              />
            </section>
          )}
        </Show>
      );
    };

    return context.ui.registerEmbeddedContentRenderer({
      id: MCP_APP_RENDERER_ID,
      component: McpAppFrame,
    });
  },
});
