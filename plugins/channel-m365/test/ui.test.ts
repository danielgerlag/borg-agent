import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Microsoft 365 settings UI contract", () => {
  it("registers m365- test ids and never reads secrets or tokens", async () => {
    const source = await readFile(
      new URL("../src/ui.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('id: "borg.channel.m365.settings"');
    expect(source).toContain('label: "Microsoft 365"');
    expect(source).toContain("order: 47");
    expect(source).toContain('data-testid="m365-settings-page"');
    expect(source).toContain('data-testid="m365-client-id"');
    expect(source).toContain('data-testid="m365-tenant"');
    expect(source).toContain('data-testid="m365-enabled"');
    expect(source).toContain('data-testid="m365-allowed-recipients"');
    expect(source).toContain('data-testid="m365-save"');
    expect(source).toContain('data-testid="m365-connect"');
    expect(source).toContain('data-testid="m365-disconnect"');
    expect(source).toContain("http://localhost");
    expect(source).toContain("context.config.update");
    expect(source).not.toMatch(/secrets\.get\s*\(/);
    expect(source).not.toMatch(/refresh_token/);
    expect(source).not.toMatch(/access_token/);
    expect(source).not.toMatch(/clientSecret/);
  });
});
