import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { Kernel } from "@borg-agent/kernel";
import { z } from "zod";

const invokePayload = z.object({ id: z.string(), input: z.unknown() }).strict();

export interface UiHostOptions {
  readonly title: string;
  readonly kernel: Kernel;
  readonly rendererDirectory: string;
}

function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

export async function launchUiHost(options: UiHostOptions): Promise<void> {
  await app.whenReady();
  await options.kernel.start();
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void options.kernel.stop().finally(() => {
      app.quit();
    });
  };

  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: options.title,
    backgroundColor: "#090b10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ipcMain.handle("borg:command:invoke", async (event, payload: unknown) => {
    if (event.sender.id !== window.webContents.id) {
      return {
        ok: false as const,
        error: { code: "forbidden", message: "Untrusted renderer" },
      };
    }
    try {
      const request = invokePayload.parse(payload);
      const value = await options.kernel.bus.invokeById(
        request.id,
        request.input,
        { source: { kind: "renderer", id: String(event.sender.id) } },
      );
      return { ok: true as const, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      return { ok: false as const, error: { code: "failed", message } };
    }
  });

  window.on("close", (event) => {
    if (!stopping) {
      event.preventDefault();
      shutdown();
    }
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  await window.loadFile(path.join(options.rendererDirectory, "index.html"));
}
