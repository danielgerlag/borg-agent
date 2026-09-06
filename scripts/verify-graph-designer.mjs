import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktopApp = path.join(projectRoot, "apps/desktop");
const outputDirectory = path.resolve(
  process.argv[2] ?? path.join(projectRoot, "test-results/graph-designer"),
);
const profileDirectory = mkdtempSync(
  path.join(tmpdir(), "borg-graph-designer-"),
);
const require = createRequire(import.meta.url);
const electronPath = require(
  require.resolve("electron", { paths: [desktopApp] }),
);
const launchEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => name !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
  ),
);
launchEnvironment.BORG_E2E = "1";
launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

mkdirSync(outputDirectory, { recursive: true });

async function completeSetup(page) {
  await page.getByTestId("surface-wizard").waitFor();
  await page.getByTestId("setup-continue").click();

  const storageStatus = page.getByTestId("dev-secret-status");
  await storageStatus.waitFor();
  if (!(await storageStatus.textContent())?.includes("ready")) {
    await page.getByTestId("dev-secret-save").click();
    await storageStatus
      .filter({ hasText: "storage is ready" })
      .waitFor();
  }
  await page.getByTestId("setup-continue").click();

  const openaiStep = page.getByTestId("openai-setup-step");
  const anthropicStep = page.getByTestId("anthropic-setup-step");
  const personaStep = page.getByTestId("wizard-persona-step");
  for (let remaining = 2; remaining > 0; remaining -= 1) {
    await openaiStep.or(anthropicStep).or(personaStep).waitFor();
    if (await openaiStep.isVisible()) {
      await page.getByTestId("setup-continue").click();
      continue;
    }
    if (await anthropicStep.isVisible()) {
      await page.getByTestId("setup-continue").click();
      continue;
    }
    break;
  }

  await personaStep.waitFor();
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("setup-complete").click();
  await page.getByTestId("chat-workspace").waitFor();
}

async function setWindowSize(application, width, height) {
  await application.evaluate(
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

async function captureGraphDesignerEvidence(page, name) {
  await page.waitForTimeout(250);
  const metrics = await page.evaluate(() => {
    const designer = document.querySelector(
      '[data-testid="graph-designer"]',
    );
    const canvas = document.querySelector('[data-testid="graph-canvas"]');
    const addNode = document.querySelector('[data-testid="graph-add-node"]');
    const inspector = document.querySelector(
      '[data-testid="graph-node-inspector"]',
    );
    const canvasParent = canvas?.parentElement;
    if (
      !(designer instanceof HTMLElement) ||
      !(canvas instanceof HTMLElement) ||
      !(canvasParent instanceof HTMLElement) ||
      !(addNode instanceof HTMLElement) ||
      !(inspector instanceof HTMLElement)
    ) {
      throw new Error("Graph designer controls are missing");
    }

    const rect = (element) => {
      const box = element.getBoundingClientRect();
      const visibleWidth = Math.max(
        0,
        Math.min(box.right, window.innerWidth) - Math.max(box.left, 0),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0),
      );
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        visibleWidth,
        visibleHeight,
      };
    };

    const canvases = [...canvas.querySelectorAll("canvas")];
    const countSampledOpaquePixels = (layers) => {
      let count = 0;
      for (const layer of layers) {
        const context = layer.getContext("2d", {
          willReadFrequently: true,
        });
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

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      designer: rect(designer),
      canvasParent: rect(canvasParent),
      canvas: rect(canvas),
      addNode: rect(addNode),
      inspector: rect(inspector),
      overflowWidth: designer.scrollWidth - designer.clientWidth,
      canvasLayers: canvases.map((layer) => ({
        width: layer.width,
        height: layer.height,
      })),
      canvasStyle: Object.fromEntries(
        ["position", "top", "right", "bottom", "left", "width", "height"].map(
          (property) => [
            property,
            getComputedStyle(canvas).getPropertyValue(property),
          ],
        ),
      ),
      opaquePixels: countSampledOpaquePixels(canvases),
      nodeOptions: document.querySelectorAll(
        '[data-testid^="graph-node-option-"]',
      ).length,
    };
  });

  await page.screenshot({
    path: path.join(outputDirectory, `${name}.png`),
  });
  writeFileSync(
    path.join(outputDirectory, `${name}.json`),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  return metrics;
}

let application;
try {
  application = await electron.launch({
    executablePath: electronPath,
    args: [desktopApp, `--user-data-dir=${profileDirectory}`],
    env: launchEnvironment,
  });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await completeSetup(page);
  await page.getByTestId("workspace-view-tab-borg.graphs.designer").click();
  await page.getByTestId("graph-designer").waitFor();
  await page.getByTestId("graph-create").click();
  await page.getByTestId("graph-name").waitFor();

  await setWindowSize(application, 1180, 760);
  const defaultSize = await captureGraphDesignerEvidence(page, "default");
  await setWindowSize(application, 860, 600);
  const minimumSize = await captureGraphDesignerEvidence(page, "minimum");

  for (const [name, metrics] of [
    ["default", defaultSize],
    ["minimum", minimumSize],
  ]) {
    assert.ok(metrics.designer.height >= 400, `${name} designer is too short`);
    assert.ok(metrics.canvas.width >= 280, `${name} canvas is too narrow`);
    assert.ok(metrics.canvas.height >= 250, `${name} canvas is too short`);
    assert.ok(metrics.canvasLayers.length > 0, `${name} canvas has no layers`);
    assert.ok(metrics.opaquePixels > 100, `${name} canvas drew no graph`);
    assert.equal(metrics.nodeOptions, 3, `${name} graph nodes are missing`);
    assert.ok(
      metrics.addNode.visibleWidth > 100 &&
        metrics.addNode.visibleHeight > 20,
      `${name} add-step control is outside the viewport`,
    );
    assert.ok(
      metrics.inspector.visibleWidth > 150,
      `${name} inspector is outside the viewport`,
    );
    assert.ok(
      metrics.overflowWidth <= 1,
      `${name} designer clips ${metrics.overflowWidth}px horizontally`,
    );
  }

  process.stdout.write(`${JSON.stringify({ defaultSize, minimumSize }, null, 2)}\n`);
} finally {
  await application?.close();
  rmSync(profileDirectory, { recursive: true, force: true });
}
