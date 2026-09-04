import { mockChannelInject, mockChannelSend } from "@borg/contracts";
import { definePlugin, type PluginContext } from "@borg/plugin-sdk";
import {
  MOCK_CHANNEL_ADAPTER_ID,
  MOCK_CHANNEL_DESTINATION,
  MockChannelRuntime,
} from "./runtime";

export {
  MOCK_CHANNEL_ADAPTER_ID,
  MOCK_CHANNEL_DESTINATION,
  MockChannelDisposedError,
  MockChannelNotStartedError,
  MockChannelRuntime,
} from "./runtime";
export type {
  MockChannelInjectInput,
  MockChannelInjectResult,
  MockOutboundRecord,
} from "./runtime";

const runtimes = new WeakMap<PluginContext, MockChannelRuntime>();

function disposeRuntime(context: PluginContext): void {
  const runtime = runtimes.get(context);
  if (!runtime) {
    return;
  }
  runtime.dispose();
  runtimes.delete(context);
}

export default definePlugin({
  id: "borg.channel.mock",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["channels.register", "channels.send"],
  contributes: {
    commands: [mockChannelInject.id, mockChannelSend.id],
    kinds: ["channel"],
  },
  activate(context) {
    const runtime = new MockChannelRuntime();
    runtimes.set(context, runtime);
    const adapter = context.channels.register(runtime);
    const injectCommand = context.bus.handle(
      mockChannelInject,
      async (input, signal) => {
        signal.throwIfAborted();
        return runtime.inject(mockChannelInject.input.parse(input), signal);
      },
    );
    const sendCommand = context.bus.handle(mockChannelSend, async (input, signal) => {
      const receipt = await context.channels.send({
        adapterId: MOCK_CHANNEL_ADAPTER_ID,
        destinationId: input.destinationId ?? MOCK_CHANNEL_DESTINATION,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
        signal,
        ...(input.classification !== undefined
          ? { classification: input.classification }
          : {}),
      });
      return receipt.status === "denied"
        ? { ...receipt, reasons: [...receipt.reasons] }
        : { ...receipt };
    });
    return {
      dispose() {
        disposeRuntime(context);
        adapter.dispose();
        injectCommand.dispose();
        sendCommand.dispose();
      },
    };
  },
  deactivate(context) {
    disposeRuntime(context);
  },
});
