import {
  MCP_APP_BRIDGE_CHANNEL,
  MCP_APP_MAX_MESSAGE_BYTES,
} from "@borg/contracts";
import {
  app,
  protocol,
  session,
  webContents,
  type Event as ElectronEvent,
  type WebContents,
  type WebContentsWillFrameNavigateEventParams,
} from "electron";
import {
  EMBEDDED_CONTENT_SCHEME,
  isEmbeddedProxyUrl,
  shouldAllowEmbeddedRequest,
} from "./embedded-content-policy";

export { EMBEDDED_CONTENT_SCHEME } from "./embedded-content-policy";
const MAX_APP_HTML_BYTES = 2 * 1024 * 1024;

const bridgeScript = `
(function () {
  "use strict";
  var channel = ${JSON.stringify(MCP_APP_BRIDGE_CHANNEL)};
  var maxMessageBytes = ${MCP_APP_MAX_MESSAGE_BYTES};
  var maxAppHtmlBytes = ${MAX_APP_HTML_BYTES};
  var proxyReadyMethod = "ui/notifications/sandbox-proxy-ready";
  var resourceReadyMethod = "ui/notifications/sandbox-resource-ready";
  var params = new URLSearchParams(window.location.search);
  var instanceId = params.get("instanceId");
  var nonce = params.get("nonce");
  var parentOrigin = params.get("parentOrigin");
  var app = document.getElementById("app");
  var initialized = false;
  if (!instanceId || !nonce || !parentOrigin || !app) {
    return;
  }
  function cleanPayload(value) {
    try {
      var serialized = JSON.stringify(value);
      if (
        serialized === undefined ||
        new TextEncoder().encode(serialized).byteLength > maxMessageBytes
      ) {
        return undefined;
      }
      return JSON.parse(serialized);
    } catch (_) {
      return undefined;
    }
  }
  function validEnvelope(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    var keys = Object.keys(value);
    if (
      keys.length !== 4 ||
      !keys.every(function (key) {
        return (
          key === "channel" ||
          key === "instanceId" ||
          key === "nonce" ||
          key === "payload"
        );
      })
    ) {
      return false;
    }
    return (
      value.channel === channel &&
      value.instanceId === instanceId &&
      value.nonce === nonce
    );
  }
  function validInit(value) {
    return (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 3 &&
      value.jsonrpc === "2.0" &&
      value.method === resourceReadyMethod &&
      value.params &&
      typeof value.params === "object" &&
      !Array.isArray(value.params) &&
      Object.keys(value.params).length === 1 &&
      typeof value.params.html === "string" &&
      new TextEncoder().encode(value.params.html).byteLength <= maxAppHtmlBytes
    );
  }
  function reserved(value) {
    return (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.method === "string" &&
      value.method.indexOf("ui/notifications/sandbox-") === 0
    );
  }
  function sendToParent(payload) {
    window.parent.postMessage(
      {
        channel: channel,
        instanceId: instanceId,
        nonce: nonce,
        payload: payload
      },
      parentOrigin === "null" ? "*" : parentOrigin
    );
  }
  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== parentOrigin || !validEnvelope(event.data)) {
        return;
      }
      if (!initialized) {
        if (!validInit(event.data.payload)) {
          return;
        }
        initialized = true;
        app.srcdoc = event.data.payload.params.html;
        return;
      }
      var incoming = cleanPayload(event.data.payload);
      if (incoming !== undefined && !reserved(incoming) && app.contentWindow) {
        app.contentWindow.postMessage(incoming, "*");
      }
      return;
    }
    if (
      !initialized ||
      event.source !== app.contentWindow ||
      event.origin !== "null"
    ) {
      return;
    }
    var outgoing = cleanPayload(event.data);
    if (outgoing !== undefined && !reserved(outgoing)) {
      sendToParent(outgoing);
    }
  });
  sendToParent({
    jsonrpc: "2.0",
    method: proxyReadyMethod,
    params: {}
  });
})();
`;

const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "connect-src 'none'",
  "img-src data: blob:",
  "font-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const permissionsPolicy = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "display-capture=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "window-management=()",
].join(", ");

const proxyDocument = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="referrer" content="no-referrer">
<style>html,body,#app{box-sizing:border-box;margin:0;min-height:100%;width:100%}#app{border:0;display:block;min-height:18rem}</style>
</head>
<body>
<iframe id="app" sandbox="allow-scripts" csp="${policy}" referrerpolicy="no-referrer" title="MCP App"></iframe>
<script>${bridgeScript}</script>
</body>
</html>`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: EMBEDDED_CONTENT_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      bypassCSP: false,
      stream: true,
    },
  },
]);

export function installEmbeddedContentProtocol(): () => void {
  const guards = new Map<
    WebContents,
    {
      readonly guard: (
        event: ElectronEvent<WebContentsWillFrameNavigateEventParams>,
      ) => void;
      readonly destroy: () => void;
    }
  >();
  const guardContents = (contents: WebContents): void => {
    if (contents.isDestroyed() || guards.has(contents)) {
      return;
    }
    const guard = (
      event: ElectronEvent<WebContentsWillFrameNavigateEventParams>,
    ): void => {
      if (
        event.isMainFrame ||
        event.url === "about:srcdoc" ||
        !isEmbeddedProxyUrl(event.frame?.parent?.url ?? "")
      ) {
        return;
      }
      event.preventDefault();
    };
    const destroy = (): void => {
      guards.delete(contents);
    };
    guards.set(contents, { guard, destroy });
    contents.on("will-frame-navigate", guard);
    contents.once("destroyed", destroy);
  };
  const onWebContentsCreated = (
    _event: ElectronEvent,
    contents: WebContents,
  ): void => {
    guardContents(contents);
  };
  app.on("web-contents-created", onWebContentsCreated);
  for (const contents of webContents.getAllWebContents()) {
    guardContents(contents);
  }
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback(shouldAllowEmbeddedRequest(details) ? {} : { cancel: true });
  });
  protocol.handle(EMBEDDED_CONTENT_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "mcp-app" || url.pathname !== "/proxy.html") {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(proxyDocument, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": policy,
        "Content-Type": "text/html; charset=utf-8",
        "Permissions-Policy": permissionsPolicy,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  return () => {
    app.removeListener("web-contents-created", onWebContentsCreated);
    for (const [contents, registration] of guards) {
      if (!contents.isDestroyed()) {
        contents.removeListener("will-frame-navigate", registration.guard);
        contents.removeListener("destroyed", registration.destroy);
      }
    }
    guards.clear();
    session.defaultSession.webRequest.onBeforeRequest(null);
    protocol.unhandle(EMBEDDED_CONTENT_SCHEME);
  };
}
