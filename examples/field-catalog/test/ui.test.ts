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

describe("field catalog window", () => {
  it("refuses Thunder Bay and files Point Pelee", async () => {
    application = await electron.launch({
      executablePath: electronPath,
      cwd: exampleDirectory,
      args: [path.join(exampleDirectory, "dist/electron-main.js")],
    });
    const page = await application.firstWindow();
    await page.getByTestId("field-place-thunder-bay").click();
    await expect(page.getByTestId("field-sighting")).toHaveText(
      "thunder bay is out of range",
    );
    await page.getByTestId("field-voucher").click();
    await expect(page.getByTestId("field-voucher-result")).toHaveText(
      "out of range",
    );
    await page.getByTestId("field-place-point-pelee").click();
    await expect(page.getByTestId("field-sighting")).toHaveText(
      "point pelee is in range",
    );
    await page.getByTestId("field-voucher").click();
    await expect(page.getByTestId("field-voucher-result")).toHaveText(
      "Voucher FC-1042",
    );
  }, 60_000);
});
