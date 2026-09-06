import { expect, type Page } from "@playwright/test";

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

  for (let remaining = 2; remaining > 0; remaining -= 1) {
    await expect(
      page
        .getByTestId("openai-setup-step")
        .or(page.getByTestId("anthropic-setup-step"))
        .or(page.getByTestId("wizard-persona-step")),
    ).toBeVisible();
    if (await page.getByTestId("openai-setup-step").isVisible()) {
      await page.getByTestId("setup-continue").click();
      continue;
    }
    if (await page.getByTestId("anthropic-setup-step").isVisible()) {
      await page.getByTestId("setup-continue").click();
      continue;
    }
    break;
  }

  await expect(page.getByTestId("wizard-persona-step")).toBeVisible();
  await expect(page.getByTestId("wizard-model-select")).not.toHaveValue("");
  await page.getByTestId("setup-continue").click();

  await expect(page.getByTestId("setup-ready")).toBeVisible();
  await page.getByTestId("setup-complete").click();
  await expect(page.getByTestId("chat-workspace")).toBeVisible();
}
