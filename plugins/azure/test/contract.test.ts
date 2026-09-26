import { describe, expect, it } from "vitest";
import {
  azureConnect,
  azureDisconnect,
  azureGetStatus,
} from "../src/contract";

describe("azure commands", () => {
  it("exports the status, connect, and disconnect commands", () => {
    expect(azureGetStatus.id).toBe("borg.azure.getStatus");
    expect(azureConnect.id).toBe("borg.azure.connect");
    expect(azureDisconnect.id).toBe("borg.azure.disconnect");
  });

  it("parses status without secret fields", () => {
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
  });
});
