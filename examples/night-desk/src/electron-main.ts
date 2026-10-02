import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { launchUiHost } from "@borg/example-ui-host";
import { createNightDeskKernel } from "./kernel";

async function main(): Promise<void> {
  app.setPath(
    "userData",
    mkdtempSync(path.join(tmpdir(), "borg-night-desk-ui-")),
  );
  await launchUiHost({
    title: "Night desk",
    kernel: createNightDeskKernel(),
    rendererDirectory: path.join(__dirname, "renderer"),
  });
}

main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
