import { describe, expect, it } from "vitest";
import {
  ollamaConnect,
  ollamaDisconnect,
  ollamaGetStatus,
} from "../src/contract";

describe("ollama commands", () => {
  it("exports the status, connect, and disconnect commands", () => {
    expect(ollamaGetStatus.id).toBe("borg.ollama.getStatus");
    expect(ollamaConnect.id).toBe("borg.ollama.connect");
    expect(ollamaDisconnect.id).toBe("borg.ollama.disconnect");
  });

  it("parses status without secret fields", () => {
    expect(
      ollamaGetStatus.output.parse({ connected: true, modelCount: 2 }),
    ).toEqual({ connected: true, modelCount: 2 });
  });
});
