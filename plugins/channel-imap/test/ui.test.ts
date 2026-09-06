import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("IMAP settings UI contract", () => {
  it("registers imap- test ids and never reads the password", async () => {
    const source = await readFile(
      new URL("../src/ui.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('id: "borg.channel.imap.settings"');
    expect(source).toContain('label: "IMAP"');
    expect(source).toContain("order: 46");
    expect(source).toContain('data-testid="imap-settings-page"');
    expect(source).toContain('data-testid="imap-enabled"');
    expect(source).toContain('data-testid="imap-host"');
    expect(source).toContain('data-testid="imap-port"');
    expect(source).toContain('data-testid="imap-username"');
    expect(source).toContain('data-testid="imap-mailbox"');
    expect(source).toContain('data-testid="imap-password"');
    expect(source).toContain('data-testid="imap-save-password"');
    expect(source).toContain('data-testid="imap-delete-password"');
    expect(source).toContain('data-testid="imap-save-settings"');
    expect(source).toContain("IMAP_PASSWORD_SECRET_KEY");
    expect(source).toContain("context.secrets.set");
    expect(source).toContain("context.secrets.delete");
    expect(source).toContain("context.secrets.has");
    expect(source).toContain("context.config.update");
    expect(source).not.toMatch(/secrets\.get\s*\(/);
  });
});
