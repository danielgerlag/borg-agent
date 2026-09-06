import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

if (process.platform !== "darwin") {
  throw new Error("The packaged app verifier must run on macOS");
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const executablePath = path.join(
  projectRoot,
  ".package",
  "output",
  `Borg-darwin-${process.arch}`,
  "Borg.app",
  "Contents",
  "MacOS",
  "Borg",
);
const profileDirectory = mkdtempSync(
  path.join(tmpdir(), "borg-packaged-smoke-"),
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => name !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
  ),
);
environment.BORG_E2E = "1";
environment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

async function completeSetup(page) {
  await page.getByTestId("setup-welcome").waitFor();
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

let application;
try {
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profileDirectory}`],
    env: environment,
  });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await completeSetup(page);
  await page.getByTestId("workspace-view-tab-borg.graphs.designer").click();
  await page.getByTestId("graph-create").click();
  await page.getByTestId("graph-node-option-manual").waitFor();
  await page.screenshot({
    path: path.join(projectRoot, ".package", "packaged-smoke.png"),
  });
  process.stdout.write(`${executablePath}\n`);
} finally {
  await application?.close();
  rmSync(profileDirectory, { recursive: true, force: true });
}
