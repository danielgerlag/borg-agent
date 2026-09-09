import { describe, expect, it } from "vitest";
import {
  defaultM365ChannelConfig,
  formatRecipientList,
  m365ChannelConfigSchema,
  parseRecipientList,
  sameM365ChannelConfig,
} from "../src/config";
import { M365_DEFAULT_TENANT, MAX_ALLOWED_RECIPIENTS } from "../src/protocol";

const RECIPIENT = "alice@contoso.com";
const OTHER = "bob@contoso.com";

function defaultAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "default",
    name: "Microsoft 365",
    enabled: false,
    clientId: "",
    tenant: M365_DEFAULT_TENANT,
    allowedRecipients: [],
    mailbox: "",
    ...overrides,
  };
}

describe("microsoft 365 channel settings", () => {
  it("parses empty config as no accounts", () => {
    const defaults = defaultM365ChannelConfig();
    expect(defaults).toEqual({ accounts: [] });
    expect(m365ChannelConfigSchema.parse({})).toEqual({ accounts: [] });
    expect(m365ChannelConfigSchema.parse(defaults)).toEqual(defaults);
  });

  it("lifts a stored singleton into the default account", () => {
    expect(
      m365ChannelConfigSchema.parse({
        enabled: true,
        clientId: "public-native-client",
        tenant: "contoso.onmicrosoft.com",
        allowedRecipients: [RECIPIENT],
        mailbox: "borg@contoso.com",
      }),
    ).toEqual({
      accounts: [
        defaultAccount({
          enabled: true,
          clientId: "public-native-client",
          tenant: "contoso.onmicrosoft.com",
          allowedRecipients: [RECIPIENT],
          mailbox: "borg@contoso.com",
        }),
      ],
    });
  });

  it("drops leftover singleton keys when accounts is present", () => {
    expect(
      m365ChannelConfigSchema.parse({
        accounts: [{ id: "work", name: "Work" }],
        enabled: true,
      }),
    ).toEqual({
      accounts: [defaultAccount({ id: "work", name: "Work" })],
    });
  });

  it("refuses unknown keys", () => {
    expect(
      m365ChannelConfigSchema.safeParse({ enabled: false, botToken: "leak" })
        .success,
    ).toBe(false);
    expect(
      m365ChannelConfigSchema.safeParse({
        enabled: false,
        extra: "nope",
      }).success,
    ).toBe(false);
  });

  it("requires unique ids and at most eight accounts", () => {
    expect(
      m365ChannelConfigSchema.safeParse({
        accounts: [
          { id: "work", name: "Work" },
          { id: "work", name: "Also work" },
        ],
      }).success,
    ).toBe(false);
    expect(
      m365ChannelConfigSchema.safeParse({
        accounts: Array.from({ length: 8 }, (_value, index) => ({
          id: `acct-${index}`,
          name: `Account ${index}`,
        })),
      }).success,
    ).toBe(true);
    expect(
      m365ChannelConfigSchema.safeParse({
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
      m365ChannelConfigSchema.safeParse({
        allowedRecipients: Array.from(
          { length: MAX_ALLOWED_RECIPIENTS + 1 },
          (_value, index) => `user${String(index)}@contoso.com`,
        ),
      }).success,
    ).toBe(false);
  });

  it("compares configurations by value", () => {
    const left = m365ChannelConfigSchema.parse({
      enabled: true,
      clientId: "public-native-client",
    });
    expect(
      sameM365ChannelConfig(
        left,
        m365ChannelConfigSchema.parse({
          enabled: true,
          clientId: "public-native-client",
        }),
      ),
    ).toBe(true);
    expect(
      sameM365ChannelConfig(
        left,
        m365ChannelConfigSchema.parse({
          enabled: false,
          clientId: "public-native-client",
        }),
      ),
    ).toBe(false);
  });
});
