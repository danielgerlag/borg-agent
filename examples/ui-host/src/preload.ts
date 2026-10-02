import { contextBridge, ipcRenderer } from "electron";

function readBridgeResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("ok" in result)) {
    throw new Error("Command bridge returned an invalid result");
  }
  if (result.ok === true && "value" in result) {
    return result.value;
  }
  if (
    result.ok === false &&
    "error" in result &&
    typeof result.error === "object" &&
    result.error !== null &&
    "message" in result.error &&
    typeof result.error.message === "string"
  ) {
    throw new Error(result.error.message);
  }
  throw new Error("Command bridge returned an invalid result");
}

contextBridge.exposeInMainWorld("borg", {
  command: {
    invoke: async (id: string, input: unknown): Promise<unknown> =>
      readBridgeResult(
        await ipcRenderer.invoke("borg:command:invoke", { id, input }),
      ),
  },
});
