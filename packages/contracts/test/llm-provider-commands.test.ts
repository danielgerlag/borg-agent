import { describe, expect, it } from "vitest";
import {
  azureConnect,
  azureDisconnect,
  azureGetStatus,
  copilotConnect,
  copilotDisconnect,
  copilotGetStatus,
  copilotPollDeviceFlow,
  copilotStartDeviceFlow,
  ollamaConnect,
  ollamaDisconnect,
  ollamaGetStatus,
  openaiDisconnect,
  openrouterConnect,
  openrouterDisconnect,
  openrouterGetStatus,
} from "../src/index";

describe("llm provider commands", () => {
  it("exports Azure, Copilot, Ollama, and OpenRouter commands after openai", () => {
    expect(openaiDisconnect.id).toBe("borg.openai.disconnect");
    expect(azureGetStatus.id).toBe("borg.azure.getStatus");
    expect(azureConnect.id).toBe("borg.azure.connect");
    expect(azureDisconnect.id).toBe("borg.azure.disconnect");
    expect(copilotGetStatus.id).toBe("borg.copilot.getStatus");
    expect(copilotConnect.id).toBe("borg.copilot.connect");
    expect(copilotDisconnect.id).toBe("borg.copilot.disconnect");
    expect(copilotStartDeviceFlow.id).toBe("borg.copilot.startDeviceFlow");
    expect(copilotPollDeviceFlow.id).toBe("borg.copilot.pollDeviceFlow");
    expect(ollamaGetStatus.id).toBe("borg.ollama.getStatus");
    expect(ollamaConnect.id).toBe("borg.ollama.connect");
    expect(ollamaDisconnect.id).toBe("borg.ollama.disconnect");
    expect(openrouterGetStatus.id).toBe("borg.openrouter.getStatus");
    expect(openrouterConnect.id).toBe("borg.openrouter.connect");
    expect(openrouterDisconnect.id).toBe("borg.openrouter.disconnect");
  });

  it("parses status and device-flow envelopes without secret fields", () => {
    expect(
      azureGetStatus.output.parse({
        hasKey: false,
        connected: true,
        authMode: "azure-default",
      }),
    ).toEqual({
      hasKey: false,
      connected: true,
      authMode: "azure-default",
    });
    expect(
      copilotStartDeviceFlow.output.parse({
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        interval: 5,
        expiresIn: 900,
      }),
    ).toEqual({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    });
    expect(() =>
      copilotStartDeviceFlow.output.parse({
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        interval: 5,
        expiresIn: 900,
        device_code: "secret-device-code",
      }),
    ).toThrow();
    expect(copilotPollDeviceFlow.output.parse({ status: "pending" })).toEqual({
      status: "pending",
    });
    expect(copilotPollDeviceFlow.output.parse({ status: "complete" })).toEqual({
      status: "complete",
    });
    expect(() =>
      copilotPollDeviceFlow.output.parse({
        status: "complete",
        access_token: "secret",
      }),
    ).toThrow();
    expect(
      copilotPollDeviceFlow.output.parse({
        status: "failed",
        error: "Copilot sign-in expired. Start again.",
      }),
    ).toEqual({
      status: "failed",
      error: "Copilot sign-in expired. Start again.",
    });
    expect(
      ollamaGetStatus.output.parse({ connected: true, modelCount: 2 }),
    ).toEqual({ connected: true, modelCount: 2 });
    expect(
      openrouterGetStatus.output.parse({ hasKey: true, connected: false }),
    ).toEqual({ hasKey: true, connected: false });
  });
});
