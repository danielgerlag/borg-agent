import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { completeSetup } from "./setup";

const projectRoot = path.resolve(__dirname, "../..");
const desktopApp = path.join(projectRoot, "apps/desktop");
const electronPath = require(
  require.resolve("electron", { paths: [desktopApp] }),
) as string;
const graphEngineId = "borg.graphs.hivemind-v1";

let application: ElectronApplication | undefined;
let page: Page;
let profileDirectory: string | undefined;
let launchEnvironment: Record<string, string>;

function waitForExit(
  child: ChildProcess,
  timeoutMs = 3_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      child.kill();
      reject(new Error("Electron cleanup timed out"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function feedbackGateGraph(
  id: string,
  name: string,
  prompt: string,
) {
  return {
    id,
    name,
    version: "1.0.0",
    engineId: graphEngineId,
    description: "A deterministic Slice 5 feedback-gate graph.",
    mode: "background",
    inputSchema: {},
    variablesSchema: {},
    nodes: [
      {
        id: "start",
        type: "trigger",
        kind: "manual",
        config: {},
        onError: { action: "fail" },
      },
      {
        id: "gate",
        type: "task",
        kind: "feedback_gate",
        config: {
          form: "confirm",
          prompt,
          title: "Slice 5 feedback gate",
          timeoutMs: 60_000,
        },
        onError: { action: "fail" },
      },
      {
        id: "finish",
        type: "control",
        kind: "end",
        config: {},
        onError: { action: "fail" },
      },
    ],
    edges: [
      { id: "start-to-gate", source: "start", target: "gate" },
      { id: "gate-to-finish", source: "gate", target: "finish" },
    ],
  };
}

async function openGraphsWorkspace(): Promise<void> {
  const tab = page.getByTestId("workspace-view-tab-borg.graphs.designer");
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText("Graphs");
  await tab.click();
  await expect(page.getByTestId("graph-designer")).toBeVisible();
}

async function seedGraph(
  definition: ReturnType<typeof feedbackGateGraph>,
): Promise<void> {
  await page.evaluate(async (candidate) => {
    await window.borg.command.invoke("borg.graphs.saveDefinition", {
      definition: candidate,
    });
  }, definition);
}

async function sendMessage(text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-send").click();
}

async function expandTranscriptEvent(text: string): Promise<void> {
  const event = page
    .locator('[data-testid="chat-message"][data-role="event"]')
    .filter({ hasText: text });
  await expect(event).toBeVisible();
  await event.locator("summary").click();
  await expect(event.locator("p")).toBeVisible();
  await expect(event.locator("p")).toContainText(text);
}

async function setWindowVisibility(visible: boolean): Promise<void> {
  const currentApplication = application;
  if (!currentApplication) {
    throw new Error("Electron is not running");
  }
  await currentApplication.evaluate((_, shouldShow) => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: {
          hideWindow(): void;
          showWindow(): void;
        };
      }
    ).__borgTest;
    if (!api) {
      throw new Error("Borg test API is unavailable");
    }
    if (shouldShow) {
      api.showWindow();
    } else {
      api.hideWindow();
    }
  }, visible);
  await expect
    .poll(() =>
      currentApplication.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { isWindowVisible(): boolean };
          }
        ).__borgTest;
        return api?.isWindowVisible() ?? false;
      }),
    )
    .toBe(visible);
}

async function setWindowSize(width: number, height: number): Promise<void> {
  const currentApplication = application;
  if (!currentApplication) {
    throw new Error("Electron is not running");
  }
  await currentApplication.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("Borg window is unavailable");
      }
      window.setSize(size.width, size.height);
    },
    { width, height },
  );
}

async function graphDesignerMetrics(): Promise<{
  readonly canvasHeight: number;
  readonly canvasLayerHeight: number;
  readonly opaquePixels: number;
  readonly addNodeVisibleWidth: number;
  readonly inspectorVisibleWidth: number;
  readonly overflowWidth: number;
}> {
  return page.getByTestId("graph-canvas").evaluate((canvas) => {
    const countSampledOpaquePixels = (
      layers: readonly HTMLCanvasElement[],
    ): number => {
      let count = 0;
      for (const layer of layers) {
        const context = layer.getContext("2d", { willReadFrequently: true });
        if (!context || layer.width === 0 || layer.height === 0) {
          continue;
        }
        const pixels = context.getImageData(
          0,
          0,
          layer.width,
          layer.height,
        ).data;
        for (
          let alphaIndex = 3;
          alphaIndex < pixels.length;
          alphaIndex += 16 * 4
        ) {
          if ((pixels[alphaIndex] ?? 0) > 0) {
            count += 1;
          }
        }
      }
      return count;
    };
    const designer = document.querySelector(
      '[data-testid="graph-designer"]',
    );
    const addNode = document.querySelector('[data-testid="graph-add-node"]');
    const inspector = document.querySelector(
      '[data-testid="graph-node-inspector"]',
    );
    if (
      !(designer instanceof HTMLElement) ||
      !(addNode instanceof HTMLElement) ||
      !(inspector instanceof HTMLElement)
    ) {
      throw new Error("Graph designer controls are unavailable");
    }
    const visibleWidth = (element: HTMLElement): number => {
      const box = element.getBoundingClientRect();
      return Math.max(
        0,
        Math.min(box.right, window.innerWidth) - Math.max(box.left, 0),
      );
    };
    const layers = [...canvas.querySelectorAll("canvas")];
    return {
      canvasHeight: canvas.getBoundingClientRect().height,
      canvasLayerHeight: layers[0]?.height ?? 0,
      opaquePixels: countSampledOpaquePixels(layers),
      addNodeVisibleWidth: visibleWidth(addNode),
      inspectorVisibleWidth: visibleWidth(inspector),
      overflowWidth: designer.scrollWidth - designer.clientWidth,
    };
  });
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-5-"));
  launchEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  launchEnvironment.BORG_E2E = "1";
  launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

  application = await electron.launch({
    executablePath: electronPath,
    args: [desktopApp, `--user-data-dir=${profileDirectory}`],
    env: launchEnvironment,
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await completeSetup(page);
});

test.afterEach(async () => {
  try {
    const process = application?.process();
    if (
      process &&
      process.exitCode === null &&
      process.signalCode === null
    ) {
      const exit = waitForExit(process);
      process.kill();
      await exit;
    }
  } catch {
    // Electron may already be gone after an assertion or renderer failure.
  } finally {
    application = undefined;
    if (profileDirectory) {
      rmSync(profileDirectory, { recursive: true, force: true });
      profileDirectory = undefined;
    }
  }
});

test("creates, renames, saves, and runs the default graph from the Graphs UI", async () => {
  await openGraphsWorkspace();
  await page.getByTestId("graph-create").click();
  await expect(page.getByTestId("graph-name")).toHaveValue("Untitled graph");

  await page.getByTestId("graph-name").fill("Slice 5 tiny graph");
  await page.getByTestId("graph-save").click();
  await expect(page.getByText("Graph saved.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("graph-list")).toContainText(
    "Slice 5 tiny graph",
  );

  await page.getByTestId("graph-run").click();
  await expect(page.getByTestId("graph-instance-status")).toHaveText(
    "Graph completed.",
  );
});

test("renders the graph canvas and keeps editor controls usable at supported window sizes", async () => {
  await openGraphsWorkspace();
  await page.getByTestId("graph-create").click();
  await expect(page.getByTestId("graph-node-option-manual")).toBeVisible();

  for (const size of [
    { name: "default", width: 1180, height: 760 },
    { name: "minimum", width: 860, height: 600 },
  ]) {
    await setWindowSize(size.width, size.height);
    await page.waitForTimeout(250);
    const metrics = await graphDesignerMetrics();
    expect(metrics.canvasHeight, `${size.name} canvas height`).toBeGreaterThan(
      250,
    );
    expect(
      metrics.canvasLayerHeight,
      `${size.name} canvas layer height`,
    ).toBeGreaterThan(250);
    expect(metrics.opaquePixels, `${size.name} graph pixels`).toBeGreaterThan(
      100,
    );
    expect(
      metrics.addNodeVisibleWidth,
      `${size.name} add-step width`,
    ).toBeGreaterThan(100);
    expect(
      metrics.inspectorVisibleWidth,
      `${size.name} inspector width`,
    ).toBeGreaterThan(150);
    expect(metrics.overflowWidth, `${size.name} overflow`).toBeLessThanOrEqual(
      1,
    );
  }

  await page.getByTestId("graph-node-option-manual").scrollIntoViewIfNeeded();
  await page.getByTestId("graph-node-option-manual").click();
  await expect(page.getByTestId("graph-node-config")).toBeVisible();
});

test("launches a graph from Chat and shows its transcript lifecycle", async () => {
  await sendMessage("scenario:graph");

  const graphToolActivity = page
    .locator('[data-testid="chat-message"][data-role="tool"]')
    .filter({ hasText: "Used graphs.run" });
  await expect(graphToolActivity).toBeVisible();
  await expect(graphToolActivity.locator("summary")).toHaveText(
    "Used graphs.run",
  );

  await expandTranscriptEvent("Graph “Quick start” started.");
  await expandTranscriptEvent("Graph “Quick start” completed.");
  await expect(page.getByTestId("chat-session-status")).toHaveText("Ready");
});

test("keeps a feedback-gate graph pending while Borg is hidden", async () => {
  const graph = feedbackGateGraph(
    "slice-5-feedback-gate",
    "Slice 5 feedback gate",
    "Continue the Slice 5 graph?",
  );
  await seedGraph(graph);
  await openGraphsWorkspace();
  await page.getByTestId(`graph-list-item-${graph.id}`).click();
  await expect(page.getByTestId("graph-name")).toHaveValue(graph.name);

  await page.getByTestId("graph-run").click();
  const overlay = page.getByTestId("interaction-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Continue the Slice 5 graph?");
  await expect(page.getByTestId("graph-instance-status")).toContainText(
    "Waiting for input",
  );

  await setWindowVisibility(false);
  await setWindowVisibility(true);
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Continue the Slice 5 graph?");
  await overlay.getByRole("button", { name: "Yes", exact: true }).click();

  await expect(overlay).toBeHidden();
  await expect(page.getByTestId("graph-instance-status")).toHaveText(
    "Graph completed.",
  );
});

test("shows a visible graph failure when feedback is unavailable", async () => {
  const graph = feedbackGateGraph(
    "slice-5-feedback-unavailable",
    "Slice 5 unavailable feedback",
    "This prompt should not be answerable.",
  );
  await seedGraph(graph);

  const rendererReloaded = page.waitForEvent("load");
  await application!.evaluate(async () => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: {
          disablePlugin(pluginId: string): Promise<void>;
        };
      }
    ).__borgTest;
    if (!api) {
      throw new Error("Borg test API is unavailable");
    }
    await api.disablePlugin("borg.feedback");
  });
  await rendererReloaded;

  await openGraphsWorkspace();
  await page.getByTestId(`graph-list-item-${graph.id}`).click();
  await expect(page.getByTestId("graph-name")).toHaveValue(graph.name);
  await page.getByTestId("graph-run").click();

  await expect(page.getByTestId("graph-instance-status")).toContainText(
    "Graph failed:",
  );
  await expect(page.getByTestId("graph-instance-status")).toContainText(
    "unavailable",
  );
  await expect(page.getByTestId("interaction-overlay")).toBeHidden();
});
