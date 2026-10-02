import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { afterEach, describe, it } from "vitest";

const exampleDirectory = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(exampleDirectory, "package.json"));
const electronPath = require("electron") as string;

let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

afterEach(async () => {
  await application?.close();
  application = undefined;
});

describe("auction clerk window", () => {
  it("rejects a low bid and hammers the standing bid", async () => {
    application = await electron.launch({
      executablePath: electronPath,
      cwd: exampleDirectory,
      args: [path.join(exampleDirectory, "dist/electron-main.js")],
    });
    const page = await application.firstWindow();
    await expect(page.getByTestId("auction-standing")).toHaveText("no bid");
    await page.getByTestId("auction-paddle").fill("2");
    await page.getByTestId("auction-amount").fill("10");
    await page.getByTestId("auction-bid").click();
    await expect(page.getByTestId("auction-standing")).toHaveText("10");
    await page.getByTestId("auction-paddle").fill("9");
    await page.getByTestId("auction-amount").fill("8");
    await page.getByTestId("auction-bid").click();
    await expect(page.getByTestId("auction-tape")).toContainText(
      "bid 8 does not beat 10",
    );
    await expect(page.getByTestId("auction-standing")).toHaveText("10");
    await page.getByTestId("auction-paddle").fill("4");
    await page.getByTestId("auction-amount").fill("15");
    await page.getByTestId("auction-bid").click();
    await expect(page.getByTestId("auction-standing")).toHaveText("15");
    await page.getByTestId("auction-hammer").click();
    await expect(page.getByTestId("auction-hammered")).toHaveText(
      "Hammered at 15 to paddle 4",
    );
  }, 60_000);
});
