import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Google settings UI contract", () => {
  it("registers google- test ids and never reads secrets or tokens", async () => {
    const source = await readFile(
      new URL("../src/ui.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('id: "borg.channel.google.settings"');
    expect(source).toContain('label: "Google"');
    expect(source).toContain("order: 48");
    expect(source).toContain('data-testid="google-settings-page"');
    expect(source).toContain('data-testid="google-client-id"');
    expect(source).toContain('data-testid="google-enabled"');
    expect(source).toContain('data-testid="google-allowed-recipients"');
    expect(source).toContain('data-testid="google-save"');
    expect(source).toContain('data-testid="google-connect"');
    expect(source).toContain('data-testid="google-disconnect"');
    expect(source).toContain("http://127.0.0.1");
    expect(source).toContain("context.config.update");
    expect(source).not.toMatch(/secrets\.get\s*\(/);
    expect(source).not.toMatch(/refresh_token/);
    expect(source).not.toMatch(/access_token/);
    expect(source).not.toMatch(/clientSecret/);
  });
});
