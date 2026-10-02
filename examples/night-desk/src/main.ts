import { createNightDeskKernel } from "./kernel";

async function main(): Promise<void> {
  const kernel = createNightDeskKernel();
  let failed = false;
  try {
    await kernel.start();
    const run = await kernel.loops.start({
      prompt: "A page just fired.",
      providerId: "example.night-desk.model",
      modelId: "scripted",
      security: {
        kind: "root",
        subject: { kind: "night-desk", id: "p-19" },
        classification: "internal",
        provenance: { kind: "plugin", id: "example.night-desk" },
        operationPrefix: "night-desk/page",
      },
    });
    const deadline = Date.now() + 10_000;
    let snapshot = kernel.loops.get(run.id);
    while (
      snapshot?.status !== "completed" &&
      snapshot?.status !== "failed" &&
      snapshot?.status !== "cancelled" &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      snapshot = kernel.loops.get(run.id);
    }
    if (
      snapshot?.status === "completed" &&
      typeof snapshot.output === "string"
    ) {
      console.log(snapshot.output);
    } else {
      console.error(snapshot?.status, snapshot?.error);
      failed = true;
    }
  } finally {
    await kernel.stop();
  }
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
