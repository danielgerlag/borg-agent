import { describe, expect, it } from "vitest";
import {
  defaultGoogleChannelConfig,
  formatRecipientList,
  googleChannelConfigSchema,
  parseRecipientList,
  sameGoogleChannelConfig,
} from "../src/config";
import { MAX_ALLOWED_RECIPIENTS } from "../src/protocol";

const RECIPIENT = "alice@gmail.com";
const OTHER = "bob@gmail.com";

function defaultAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "default",
    name: "Google",
    enabled: false,
    clientId: "",
    allowedRecipients: [],
    mailbox: "",
    ...overrides,
  };
}

describe("google channel settings", () => {
  it("parses empty config as no accounts", () => {
    const defaults = defaultGoogleChannelConfig();
    expect(defaults).toEqual({ accounts: [] });
    expect(googleChannelConfigSchema.parse({})).toEqual({ accounts: [] });
    expect(googleChannelConfigSchema.parse(defaults)).toEqual(defaults);
  });

  it("lifts a stored singleton into the default account", () => {
    expect(
      googleChannelConfigSchema.parse({
        enabled: true,
        clientId: "desktop-client",
        allowedRecipients: [RECIPIENT],
        mailbox: "borg@gmail.com",
      }),
    ).toEqual({
      accounts: [
        defaultAccount({
          enabled: true,
          clientId: "desktop-client",
          allowedRecipients: [RECIPIENT],
          mailbox: "borg@gmail.com",
        }),
      ],
    });
  });

  it("drops leftover singleton keys when accounts is present", () => {
    expect(
      googleChannelConfigSchema.parse({
        accounts: [{ id: "work", name: "Work" }],
        enabled: true,
      }),
    ).toEqual({
      accounts: [defaultAccount({ id: "work", name: "Work" })],
    });
  });

  it("refuses unknown keys", () => {
    expect(
      googleChannelConfigSchema.safeParse({ enabled: false, botToken: "leak" })
        .success,
    ).toBe(false);
    expect(
      googleChannelConfigSchema.safeParse({
        enabled: false,
        extra: "nope",
      }).success,
    ).toBe(false);
  });

  it("requires unique ids and at most eight accounts", () => {
    expect(
      googleChannelConfigSchema.safeParse({
        accounts: [
          { id: "work", name: "Work" },
          { id: "work", name: "Also work" },
        ],
      }).success,
    ).toBe(false);
    expect(
      googleChannelConfigSchema.safeParse({
        accounts: Array.from({ length: 8 }, (_value, index) => ({
          id: `acct-${index}`,
          name: `Account ${index}`,
        })),
      }).success,
    ).toBe(true);
    expect(
      googleChannelConfigSchema.safeParse({
        accounts: Array.from({ length: 9 }, (_value, index) => ({
          id: `acct-${index}`,
          name: `Account ${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("parses the settings page recipient list", () => {
    expect(parseRecipientList(` ${RECIPIENT}\n\n ${OTHER} , `)).toEqual([
      RECIPIENT,
      OTHER,
    ]);
    expect(parseRecipientList("   ")).toEqual([]);
    expect(() => parseRecipientList("not-an-email")).toThrow(
      "Allowed recipients must be email addresses",
    );
    expect(() => parseRecipientList(`${RECIPIENT}\n${RECIPIENT}`)).toThrow(
      "Allowed recipients must be unique",
    );
    expect(formatRecipientList([RECIPIENT, OTHER])).toBe(
      `${RECIPIENT}\n${OTHER}`,
    );
    expect(
      googleChannelConfigSchema.safeParse({
        allowedRecipients: Array.from(
          { length: MAX_ALLOWED_RECIPIENTS + 1 },
          (_value, index) => `user${String(index)}@gmail.com`,
        ),
      }).success,
    ).toBe(false);
  });

  it("compares configurations by value", () => {
    const left = googleChannelConfigSchema.parse({
      enabled: true,
      clientId: "desktop-client",
    });
    expect(
      sameGoogleChannelConfig(
        left,
        googleChannelConfigSchema.parse({
          enabled: true,
          clientId: "desktop-client",
        }),
      ),
    ).toBe(true);
    expect(
      sameGoogleChannelConfig(
        left,
        googleChannelConfigSchema.parse({
          enabled: false,
          clientId: "desktop-client",
        }),
      ),
    ).toBe(false);
  });
});
