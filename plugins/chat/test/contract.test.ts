import { describe, expect, it } from "vitest";
import {
  chatImportWorkspaceFiles,
  chatPreviewWorkspaceFile,
  chatWorkspaceUpdated,
} from "../src/contract";

describe("chat workspace commands", () => {
  it("exports chat preview and import commands with a workspace updated event", () => {
    expect(chatPreviewWorkspaceFile.id).toBe("borg.chat.previewWorkspaceFile");
    expect(chatImportWorkspaceFiles.id).toBe("borg.chat.importWorkspaceFiles");
    expect(chatWorkspaceUpdated.id).toBe("borg.chat.workspace.updated");
    expect(
      chatImportWorkspaceFiles.input.parse({
        sessionId: "f713c604-fdd1-47d4-abdc-82c71ec42fb0",
        nativePaths: ["/tmp/note.txt"],
      }),
    ).toEqual({
      sessionId: "f713c604-fdd1-47d4-abdc-82c71ec42fb0",
      nativePaths: ["/tmp/note.txt"],
    });
  });
});
