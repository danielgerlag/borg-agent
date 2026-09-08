import { describe, expect, it } from "vitest";
import {
  defaultSlackChannelConfig,
  formatChannelList,
  parseChannelList,
  parseOptionalChannelId,
  sameSlackChannelConfig,
  slackChannelConfigSchema,
  slackChannelSettingsSchema,
} from "../src/config";
import { MAX_ALLOWED_CHANNEL_IDS } from "../src/protocol";

const CHANNEL_ID = "C01234567";
const DM_ID = "D01234567";
const GROUP_ID = "G01234567";

function channelIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_value, index) => `C${String(index).padStart(8, "0")}`,
  );
}

describe("slack channel settings", () => {
  it("survives the defaults-only round trip the host performs at activation", () => {
    const defaults = defaultSlackChannelConfig();
    expect(defaults).toEqual({
      enabled: false,
      ignoreBots: true,
      allowedChannelIds: [],
      defaultSendChannelId: "",
    });
    expect(slackChannelConfigSchema.parse(defaults)).toEqual(defaults);
  });

  it("refuses unknown keys", () => {
    expect(
      slackChannelConfigSchema.safeParse({ enabled: false, botToken: "leak" })
        .success,
    ).toBe(false);
    expect(
      slackChannelConfigSchema.safeParse({ enabled: false, appToken: "leak" })
        .success,
    ).toBe(false);
  });

  it("requires an allowed channel only while Slack is enabled", () => {
    expect(
      slackChannelConfigSchema.safeParse({
        enabled: true,
        allowedChannelIds: [],
      }).success,
    ).toBe(false);
    expect(
      slackChannelConfigSchema.safeParse({
        enabled: true,
        allowedChannelIds: [CHANNEL_ID],
      }).success,
    ).toBe(true);
    expect(
      slackChannelSettingsSchema.safeParse({
        enabled: false,
        ignoreBots: true,
        allowedChannelIds: [],
        defaultSendChannelId: "",
      }).success,
    ).toBe(true);
  });

  it("validates Slack ids, rejects duplicates, and bounds the list", () => {
    for (const value of ["", "C123", "X01234567", "c01234567", "C01234567!"]) {
      expect(
        slackChannelConfigSchema.safeParse({ allowedChannelIds: [value] })
          .success,
      ).toBe(false);
    }
    expect(
      slackChannelConfigSchema.safeParse({
        allowedChannelIds: [CHANNEL_ID, CHANNEL_ID],
      }).success,
    ).toBe(false);
    expect(
      slackChannelConfigSchema.safeParse({
        allowedChannelIds: [CHANNEL_ID, DM_ID, GROUP_ID],
      }).success,
    ).toBe(true);
    expect(
      slackChannelConfigSchema.safeParse({
        allowedChannelIds: channelIds(MAX_ALLOWED_CHANNEL_IDS + 1),
      }).success,
    ).toBe(false);
    expect(
      slackChannelConfigSchema.safeParse({
        allowedChannelIds: channelIds(MAX_ALLOWED_CHANNEL_IDS),
      }).success,
    ).toBe(true);
  });

  it("requires the default send channel to be in the allow-list when set", () => {
    expect(
      slackChannelConfigSchema.safeParse({
        allowedChannelIds: [CHANNEL_ID],
        defaultSendChannelId: CHANNEL_ID,
      }).success,
    ).toBe(true);
    expect(
      slackChannelConfigSchema.safeParse({
        allowedChannelIds: [CHANNEL_ID],
        defaultSendChannelId: DM_ID,
      }).success,
    ).toBe(false);
    expect(
      slackChannelConfigSchema.safeParse({
        defaultSendChannelId: "",
      }).success,
    ).toBe(true);
  });

  it("parses the settings page text areas", () => {
    expect(
      parseChannelList(` ${CHANNEL_ID}\n\n ${DM_ID} , `, "Channel ids"),
    ).toEqual([CHANNEL_ID, DM_ID]);
    expect(parseChannelList("   ", "Channel ids")).toEqual([]);
    expect(() => parseChannelList("abc", "Channel ids")).toThrow(
      "Channel ids must be C, D, or G Slack channel ids",
    );
    expect(() =>
      parseChannelList(`${CHANNEL_ID}\n${CHANNEL_ID}`, "Channel ids"),
    ).toThrow("Channel ids must be unique");
    expect(formatChannelList([CHANNEL_ID, DM_ID])).toBe(
      `${CHANNEL_ID}\n${DM_ID}`,
    );
    expect(parseOptionalChannelId("  ", "Default send channel")).toBe("");
    expect(parseOptionalChannelId(` ${CHANNEL_ID} `, "Default send channel")).toBe(
      CHANNEL_ID,
    );
  });

  it("compares configurations by value", () => {
    const left = slackChannelConfigSchema.parse({
      allowedChannelIds: [CHANNEL_ID],
    });
    expect(
      sameSlackChannelConfig(
        left,
        slackChannelConfigSchema.parse({ allowedChannelIds: [CHANNEL_ID] }),
      ),
    ).toBe(true);
    expect(
      sameSlackChannelConfig(
        left,
        slackChannelConfigSchema.parse({
          allowedChannelIds: [CHANNEL_ID],
          ignoreBots: false,
        }),
      ),
    ).toBe(false);
  });
});
