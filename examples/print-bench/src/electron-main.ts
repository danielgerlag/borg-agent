import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "@borg-agent/plugin-sdk";
import { startPrintBench } from "./boot.js";
import { printBenchAct, printBenchSnapshot } from "./contract.js";
import { handleProviderCall } from "./provider-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
let benchWindow: BrowserWindow | undefined;

function failure(code: string, message: string) {
  return { ok: false as const, error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The request failed.";
}

function isTrusted(event: IpcMainInvokeEvent): boolean {
  return event.sender.id === benchWindow?.webContents.id;
}

// Tests point this at an empty directory. A normal launch keeps provider keys in the app data folder.
const isolatedHome = process.env.BORG_PRINT_BENCH_HOME?.trim();
if (isolatedHome) {
  app.setPath("userData", isolatedHome);
}

void app.whenReady().then(async () => {
  const dataDirectory = app.getPath("userData");
  let kernel: Awaited<ReturnType<typeof startPrintBench>>;
  try {
    kernel = await startPrintBench(dataDirectory);
  } catch (error) {
    console.error(error);
    app.quit();
    return;
  }
  const commandBody = z.object({ id: z.string(), input: z.unknown() }).strict();
  const responseBody = z.object({ id: z.string().uuid(), response: z.unknown() }).strict();

  ipcMain.handle("print-bench:command:invoke", async (event, body: unknown) => {
    if (!isTrusted(event)) {
      return failure("forbidden", "Untrusted frame");
    }
    const parsed = commandBody.safeParse(body);
    if (!parsed.success) {
      return failure("invalid_input", "Command envelope is invalid");
    }
    try {
      if (parsed.data.id === printBenchSnapshot.id) {
        return {
          ok: true as const,
          value: await kernel.bus.invoke(
            printBenchSnapshot,
            printBenchSnapshot.input.parse(parsed.data.input),
          ),
        };
      }
      if (parsed.data.id === printBenchAct.id) {
        return {
          ok: true as const,
          value: await kernel.bus.invoke(
            printBenchAct,
            printBenchAct.input.parse(parsed.data.input),
          ),
        };
      }
      return failure("unavailable", `Unknown command ${parsed.data.id}`);
    } catch (error) {
      return failure("failed", messageOf(error));
    }
  });

  ipcMain.handle("print-bench:provider", async (event, body: unknown) => {
    if (!isTrusted(event)) {
      return failure("forbidden", "Untrusted frame");
    }
    try {
      return { ok: true as const, value: await handleProviderCall(kernel, body) };
    } catch (error) {
      return failure("failed", messageOf(error));
    }
  });

  ipcMain.handle("print-bench:interactions:list", (event) => {
    if (!isTrusted(event)) {
      return failure("forbidden", "Untrusted frame");
    }
    return { ok: true as const, value: kernel.interactions.listPending() };
  });

  ipcMain.handle("print-bench:interactions:respond", (event, body: unknown) => {
    if (!isTrusted(event)) {
      return failure("forbidden", "Untrusted frame");
    }
    const parsed = responseBody.safeParse(body);
    if (!parsed.success) {
      return failure("invalid_input", "Interaction response is invalid");
    }
    try {
      return {
        ok: true as const,
        value: kernel.interactions.respond(parsed.data.id, parsed.data.response),
      };
    } catch (error) {
      return failure("failed", messageOf(error));
    }
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: true,
    title: "Print bench",
    backgroundColor: "#090b10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  benchWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  window.on("closed", () => {
    benchWindow = undefined;
    void kernel.stop();
  });
  await window.loadFile(join(here, "renderer", "index.html"));
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("web-contents-created", (_event, contents) => {
  contents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'",
        ],
      },
    });
  });
});
