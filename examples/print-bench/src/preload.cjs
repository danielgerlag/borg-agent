// Sandboxed preloads load as CommonJS. A second file cannot be imported there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

function readBridgeResult(result) {
  if (typeof result !== "object" || result === null || !("ok" in result)) {
    throw new Error("Print bench bridge returned an invalid result");
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
  throw new Error("Print bench bridge returned an invalid result");
}

contextBridge.exposeInMainWorld("printBench", {
  command: {
    invoke: async (id, input) =>
      readBridgeResult(
        await ipcRenderer.invoke("print-bench:command:invoke", { id, input }),
      ),
  },
  provider: {
    call: async (body) =>
      readBridgeResult(await ipcRenderer.invoke("print-bench:provider", body)),
  },
  interactions: {
    list: async () =>
      readBridgeResult(await ipcRenderer.invoke("print-bench:interactions:list")),
    respond: async (id, response) =>
      readBridgeResult(
        await ipcRenderer.invoke("print-bench:interactions:respond", {
          id,
          response,
        }),
      ),
  },
});
