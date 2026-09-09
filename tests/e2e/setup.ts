import { expect, type Locator, type Page } from "@playwright/test";

export async function selectControlOption(
  field: Locator,
  value: string,
): Promise<void> {
  await field.selectOption(value, { force: true });
}

export async function expectTypingKeepsFocus(
  field: Locator,
  extra: string,
): Promise<void> {
  const before = await field.inputValue();
  await field.click();
  await field.evaluate((node) => {
    if (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement
    ) {
      const end = node.value.length;
      node.setSelectionRange(end, end);
    }
  });
  await field.pressSequentially(extra);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(`${before}${extra}`);
}

const OPTIONAL_LLM_SETUP_STEPS = [
  "openai-setup-step",
  "anthropic-setup-step",
  "azure-setup-step",
  "copilot-setup-step",
  "ollama-setup-step",
  "openrouter-setup-step",
] as const;

async function skipOptionalLlmSetupSteps(
  page: Page,
  until: "persona" | "ready",
): Promise<void> {
  const doneTestId = until === "persona" ? "wizard-persona-step" : "setup-ready";
  let visible = page.getByTestId(doneTestId);
  for (const testId of OPTIONAL_LLM_SETUP_STEPS) {
    visible = visible.or(page.getByTestId(testId));
  }
  await visible.waitFor();
  for (let remaining = OPTIONAL_LLM_SETUP_STEPS.length + 1; remaining > 0; remaining -= 1) {
    if (await page.getByTestId(doneTestId).isVisible()) {
      return;
    }
    let skipped = false;
    for (const testId of OPTIONAL_LLM_SETUP_STEPS) {
      if (await page.getByTestId(testId).isVisible()) {
        await page.getByTestId("setup-continue").click();
        skipped = true;
        break;
      }
    }
    if (!skipped) {
      return;
    }
  }
}

export async function completeSetup(page: Page): Promise<void> {
  await expect(page.getByTestId("surface-wizard")).toBeVisible();
  await expect(page.getByTestId("setup-welcome")).toBeVisible();
  await page.getByTestId("setup-continue").click();

  await expect(page.getByTestId("dev-secrets-step")).toBeVisible();
  const storageStatus = page.getByTestId("dev-secret-status");
  if (!(await storageStatus.textContent())?.includes("ready")) {
    await page.getByTestId("dev-secret-save").click();
    await expect(storageStatus).toContainText("storage is ready");
  }
  await page.getByTestId("setup-continue").click();

  await skipOptionalLlmSetupSteps(page, "persona");
  await expect(page.getByTestId("wizard-persona-step")).toBeVisible();
  await expect(page.getByTestId("wizard-model-select")).not.toHaveValue("");
  await page.getByTestId("setup-continue").click();
  await skipOptionalLlmSetupSteps(page, "ready");

  await expect(page.getByTestId("setup-ready")).toBeVisible();
  await page.getByTestId("setup-complete").click();
  await expect(page.getByTestId("chat-workspace")).toBeVisible();
}
