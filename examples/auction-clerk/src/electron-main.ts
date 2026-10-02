import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { launchUiHost } from "@borg/example-ui-host";
import { createAuctionClerkKernel } from "./kernel";

async function main(): Promise<void> {
  app.setPath(
    "userData",
    mkdtempSync(path.join(tmpdir(), "borg-auction-clerk-ui-")),
  );
  await launchUiHost({
    title: "Auction clerk",
    kernel: createAuctionClerkKernel(),
    rendererDirectory: path.join(__dirname, "renderer"),
  });
}

main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
