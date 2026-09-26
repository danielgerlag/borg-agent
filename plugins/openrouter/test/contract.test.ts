import { describe, expect, it } from "vitest";
import {
  openrouterConnect,
  openrouterDisconnect,
  openrouterGetStatus,
} from "../src/contract";

describe("openrouter commands", () => {
  it("exports the status, connect, and disconnect commands", () => {
    expect(openrouterGetStatus.id).toBe("borg.openrouter.getStatus");
    expect(openrouterConnect.id).toBe("borg.openrouter.connect");
    expect(openrouterDisconnect.id).toBe("borg.openrouter.disconnect");
  });

  it("parses status without secret fields", () => {
    expect(
      openrouterGetStatus.output.parse({ hasKey: true, connected: false }),
    ).toEqual({ hasKey: true, connected: false });
  });
});
