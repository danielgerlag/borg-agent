import { describe, expect, it } from "vitest";
import {
  defaultDiscordChannelConfig,
  discordChannelConfigSchema,
  discordChannelSettingsSchema,
  formatSnowflakeList,
  parseSnowflakeList,
  sameDiscordChannelConfig,
} from "../src/config";
import {
  MAX_ALLOWED_CHANNEL_IDS,
  MAX_ALLOWED_GUILD_IDS,
} from "../src/protocol";

const CHANNEL_ID = "100000000000000001";
const GUILD_ID = "200000000000000001";

function snowflakes(count: number): string[] {
  return Array.from(
    { length: count },
    (_value, index) => `1000000000000${String(index).padStart(5, "0")}`,
  );
}

describe("discord channel settings", () => {
  it("survives the defaults-only round trip the host performs at activation", () => {
    const defaults = defaultDiscordChannelConfig();
    expect(defaults).toEqual({
      enabled: false,
      ignoreBots: true,
      allowedGuildIds: [],
      allowedChannelIds: [],
    });
    expect(discordChannelConfigSchema.parse(defaults)).toEqual(defaults);
  });

  it("refuses unknown keys", () => {
    expect(
      discordChannelConfigSchema.safeParse({ enabled: false, botToken: "leak" })
        .success,
    ).toBe(false);
  });

  it("requires an allowed channel only while Discord is enabled", () => {
    expect(
      discordChannelConfigSchema.safeParse({
        enabled: true,
        allowedChannelIds: [],
      }).success,
    ).toBe(false);
    expect(
      discordChannelConfigSchema.safeParse({
        enabled: true,
        allowedChannelIds: [CHANNEL_ID],
      }).success,
    ).toBe(true);
    expect(
      discordChannelSettingsSchema.safeParse({
        enabled: false,
        ignoreBots: true,
        allowedGuildIds: [],
        allowedChannelIds: [],
      }).success,
    ).toBe(true);
  });

  it("validates snowflakes, rejects duplicates, and bounds the lists", () => {
    for (const value of ["", "12345", "1".repeat(21), "12345678901234567a"]) {
      expect(
        discordChannelConfigSchema.safeParse({ allowedChannelIds: [value] })
          .success,
      ).toBe(false);
    }
    expect(
      discordChannelConfigSchema.safeParse({
        allowedChannelIds: [CHANNEL_ID, CHANNEL_ID],
      }).success,
    ).toBe(false);
    expect(
      discordChannelConfigSchema.safeParse({
        allowedGuildIds: [GUILD_ID, GUILD_ID],
      }).success,
    ).toBe(false);
    expect(
      discordChannelConfigSchema.safeParse({
        allowedChannelIds: snowflakes(MAX_ALLOWED_CHANNEL_IDS + 1),
      }).success,
    ).toBe(false);
    expect(
      discordChannelConfigSchema.safeParse({
        allowedGuildIds: snowflakes(MAX_ALLOWED_GUILD_IDS + 1),
      }).success,
    ).toBe(false);
    expect(
      discordChannelConfigSchema.safeParse({
        allowedChannelIds: snowflakes(MAX_ALLOWED_CHANNEL_IDS),
        allowedGuildIds: snowflakes(MAX_ALLOWED_GUILD_IDS),
      }).success,
    ).toBe(true);
  });

  it("parses the settings page text areas", () => {
    expect(
      parseSnowflakeList(` ${CHANNEL_ID}\n\n ${GUILD_ID} , `, "Channel ids"),
    ).toEqual([CHANNEL_ID, GUILD_ID]);
    expect(parseSnowflakeList("   ", "Channel ids")).toEqual([]);
    expect(() => parseSnowflakeList("abc", "Channel ids")).toThrow(
      "Channel ids must be 17 to 20 digit Discord ids",
    );
    expect(() =>
      parseSnowflakeList(`${CHANNEL_ID}\n${CHANNEL_ID}`, "Channel ids"),
    ).toThrow("Channel ids must be unique");
    expect(formatSnowflakeList([CHANNEL_ID, GUILD_ID])).toBe(
      `${CHANNEL_ID}\n${GUILD_ID}`,
    );
  });

  it("compares configurations by value", () => {
    const left = discordChannelConfigSchema.parse({
      allowedChannelIds: [CHANNEL_ID],
    });
    expect(
      sameDiscordChannelConfig(
        left,
        discordChannelConfigSchema.parse({ allowedChannelIds: [CHANNEL_ID] }),
      ),
    ).toBe(true);
    expect(
      sameDiscordChannelConfig(
        left,
        discordChannelConfigSchema.parse({
          allowedChannelIds: [CHANNEL_ID],
          ignoreBots: false,
        }),
      ),
    ).toBe(false);
  });
});
