import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-11-25";
const APP_MIME = "text/html;profile=mcp-app";
const FORM_URI = "ui://mock/form";

const FORM_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Mock MCP Form</title></head>
<body>
  <h1>Mock form</h1>
  <button id="submit" data-testid="mcp-app-submit" type="button">Submit</button>
  <pre id="state" data-testid="mcp-app-state">idle</pre>
  <script>
  (function () {
    var INIT_ID = "ui-init-1";
    var PING_ID = "ui-ping-1";
    var CALL_ID = "ui-call-1";
    var initialized = false;
    function send(message) {
      window.parent.postMessage(message, "*");
    }
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.jsonrpc !== "2.0") {
        return;
      }
      if (data.id === INIT_ID && data.result) {
        var toolInfo = data.result.hostContext &&
          data.result.hostContext.toolInfo;
        if (
          data.result.context ||
          !toolInfo ||
          !toolInfo.tool ||
          toolInfo.tool.name !== "show-form"
        ) {
          document.getElementById("state").textContent = "invalid-initialize";
          return;
        }
        send({
          jsonrpc: "2.0",
          id: PING_ID,
          method: "ping",
          params: {}
        });
        document.getElementById("state").textContent = "pinging";
        return;
      }
      if (data.id === PING_ID && data.result) {
        initialized = true;
        send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        document.getElementById("state").textContent = "initialized";
        return;
      }
      if (data.method === "ui/notifications/tool-input") {
        document.getElementById("state").textContent =
          initialized ? "tool-input" : "premature-tool-input";
        return;
      }
      if (data.method === "ui/notifications/tool-result") {
        document.getElementById("state").textContent =
          initialized ? "tool-result" : "premature-tool-result";
        return;
      }
      if (data.id === CALL_ID && data.result) {
        var hidden = data.result.structuredContent &&
          data.result.structuredContent.hidden;
        document.getElementById("state").textContent =
          hidden === true ? "app-only:true" : "unexpected-result";
      }
    });
    send({
      jsonrpc: "2.0",
      id: INIT_ID,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appInfo: { name: "mock-form", version: "1.0.0" },
        appCapabilities: {
          tools: {},
          availableDisplayModes: ["inline"]
        }
      }
    });
    document.getElementById("submit").addEventListener("click", function () {
      send({
        jsonrpc: "2.0",
        id: CALL_ID,
        method: "tools/call",
        params: { name: "app-only", arguments: {} }
      });
    });
  })();
  </script>
</body>
</html>`;

const pending = new Map();
let uiNegotiated = false;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function pageOne() {
  return {
    tools: [
      {
        name: "echo",
        description: "Echo text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "show-form",
        description: "Show the mock MCP App form",
        inputSchema: { type: "object", properties: {} },
        ...(uiNegotiated
          ? {
              _meta: {
                ui: {
                  resourceUri: FORM_URI,
                  visibility: ["model", "app"]
                }
              }
            }
          : {}),
      },
    ],
    nextCursor: "page-2",
  };
}

function pageTwo() {
  return {
    tools: [
      {
        name: "app-only",
        description: "App-only server tool",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { visibility: ["app"] } },
      },
    ],
  };
}

async function handleCall(id, params, signal) {
  const name = params && typeof params.name === "string" ? params.name : "";
  const args = params && params.arguments && typeof params.arguments === "object"
    ? params.arguments
    : {};
  if (name === "echo") {
    if (args.text === "__hold__") {
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error("cancelled"), { cancelled: true }));
          return;
        }
        signal.onAbort = () =>
          reject(Object.assign(new Error("cancelled"), { cancelled: true }));
        pending.set(id, signal);
      });
    }
    reply(id, {
      content: [
        { type: "text", text: `echo:${String(args.text ?? "")}` },
        { type: "json", json: { echoed: String(args.text ?? "") } },
      ],
      structuredContent: { echoed: String(args.text ?? "") },
    });
    return;
  }
  if (name === "show-form") {
    reply(id, {
      content: [{ type: "text", text: "form-ready" }],
      structuredContent: { form: "mock", resourceUri: FORM_URI },
    });
    return;
  }
  if (name === "app-only") {
    reply(id, {
      content: [{ type: "text", text: "app-only" }],
      structuredContent: { hidden: true },
    });
    return;
  }
  fail(id, -32601, "Method not found");
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || message.jsonrpc !== "2.0") {
    return;
  }
  if (message.method === "notifications/cancelled") {
    const requestId = message.params && message.params.requestId;
    const signal = pending.get(requestId);
    if (signal) {
      pending.delete(requestId);
      signal.aborted = true;
      signal.onAbort?.();
    }
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (typeof message.id === "undefined") {
    return;
  }
  if (message.method === "initialize") {
    const ui = message.params &&
      message.params.capabilities &&
      message.params.capabilities.extensions &&
      message.params.capabilities.extensions["io.modelcontextprotocol/ui"];
    uiNegotiated = Boolean(
      ui &&
      Array.isArray(ui.mimeTypes) &&
      ui.mimeTypes.includes(APP_MIME)
    );
    reply(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false }, resources: {} },
      serverInfo: { name: "mock-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    const cursor = message.params && message.params.cursor;
    reply(message.id, cursor === "page-2" ? pageTwo() : pageOne());
    return;
  }
  if (message.method === "tools/call") {
    const signal = { aborted: false, onAbort: undefined };
    pending.set(message.id, signal);
    handleCall(message.id, message.params, signal)
      .catch((error) => {
        if (error && error.cancelled) {
          fail(message.id, -32000, "cancelled");
          return;
        }
        fail(message.id, -32603, "failed");
      })
      .finally(() => {
        pending.delete(message.id);
      });
    return;
  }
  if (message.method === "resources/read") {
    const uri = message.params && message.params.uri;
    if (uri !== FORM_URI || !uiNegotiated) {
      fail(message.id, -32602, "unknown resource");
      return;
    }
    reply(message.id, {
      contents: [
        {
          uri: FORM_URI,
          mimeType: APP_MIME,
          text: FORM_HTML,
          _meta: {
            ui: {
              csp: {
                resourceDomains: [],
                connectDomains: [],
                frameDomains: [],
                baseUriDomains: [],
              },
              permissions: {},
            },
          },
        },
      ],
    });
    return;
  }
  fail(message.id, -32601, `Method not found: ${message.method}`);
});
