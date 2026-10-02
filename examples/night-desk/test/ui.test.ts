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

describe("night desk window", () => {
  it("shows page p-19 and runs the mitigation", async () => {
    application = await electron.launch({
      executablePath: electronPath,
      cwd: exampleDirectory,
      args: [path.join(exampleDirectory, "dist/electron-main.js")],
    });
    const page = await application.firstWindow();
    await expect(page.getByTestId("night-desk-symptom")).toHaveText(
      "disk 98% full",
    );
    await page.getByTestId("night-desk-mitigate").click();
    await expect(page.getByTestId("night-desk-action")).toHaveText(
      "rotated the log and freed the volume",
    );
  }, 60_000);
});
