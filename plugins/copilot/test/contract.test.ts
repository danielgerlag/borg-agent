import { describe, expect, it } from "vitest";
import {
  copilotConnect,
  copilotDisconnect,
  copilotGetStatus,
  copilotPollDeviceFlow,
  copilotStartDeviceFlow,
} from "../src/contract";

describe("copilot commands", () => {
  it("exports the status, connect, disconnect, and device-flow commands", () => {
    expect(copilotGetStatus.id).toBe("borg.copilot.getStatus");
    expect(copilotConnect.id).toBe("borg.copilot.connect");
    expect(copilotDisconnect.id).toBe("borg.copilot.disconnect");
    expect(copilotStartDeviceFlow.id).toBe("borg.copilot.startDeviceFlow");
    expect(copilotPollDeviceFlow.id).toBe("borg.copilot.pollDeviceFlow");
  });

  it("parses device-flow envelopes without secret fields", () => {
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
  });
});
