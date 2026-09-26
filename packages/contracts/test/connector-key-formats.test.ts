import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  connectorAccountIdSchema,
  connectorAdapterId,
  connectorSecretKey,
  connectorStoreKey,
  oauthGrantKey,
} from "../src/index";

// These strings are persisted: secret-store keys, plugin store keys, OAuth
// grant records and bus adapter ids. Changing any format orphans existing
// user data, so every format is pinned here, independent of where the
// helpers live.
describe("connector key formats", () => {
  const pluginIds = [
    "borg.channel.slack",
    "borg.channel.discord",
    "borg.channel.imap",
    "borg.channel.m365",
    "borg.channel.google",
    "borg.coinbase",
  ];
  const unprefixed = [undefined, "", DEFAULT_CONNECTOR_ACCOUNT_ID] as const;

  it("uses 'default' as the unprefixed account id", () => {
    expect(DEFAULT_CONNECTOR_ACCOUNT_ID).toBe("default");
  });

  it("keeps the default account on the legacy single-account keys", () => {
    for (const accountId of unprefixed) {
      for (const pluginId of pluginIds) {
        expect(oauthGrantKey(pluginId, accountId)).toBe(pluginId);
        if (accountId !== undefined) {
          expect(connectorAdapterId(pluginId, accountId)).toBe(pluginId);
        }
      }
      if (accountId !== undefined) {
        expect(connectorSecretKey(accountId, "botToken")).toBe("botToken");
        expect(connectorSecretKey(accountId, "oauth.refresh")).toBe(
          "oauth.refresh",
        );
        expect(connectorStoreKey(accountId, "cursor")).toBe("cursor");
        expect(connectorStoreKey(accountId, "sync/state")).toBe("sync/state");
      }
    }
    expect(oauthGrantKey("borg.channel.google")).toBe("borg.channel.google");
  });

  it("prefixes other accounts with a fixed separator per key kind", () => {
    for (const pluginId of pluginIds) {
      expect(oauthGrantKey(pluginId, "work")).toBe(`${pluginId}.work`);
      expect(connectorAdapterId(pluginId, "work")).toBe(`${pluginId}.work`);
    }
    expect(connectorSecretKey("work", "botToken")).toBe("work.botToken");
    expect(connectorSecretKey("team-2", "appToken")).toBe("team-2.appToken");
    expect(connectorSecretKey("work", "oauth.refresh")).toBe(
      "work.oauth.refresh",
    );
    expect(connectorStoreKey("work", "cursor")).toBe("work/cursor");
    expect(connectorStoreKey("team-2", "sync/state")).toBe(
      "team-2/sync/state",
    );
  });

  it("accepts exactly the account ids the key formats can carry", () => {
    const valid = ["a", "work", "team-2", "a1-b2-c3", "a".repeat(32)];
    const invalid = [
      "Work",
      "work_space",
      "work.space",
      "work/space",
      "-work",
      "work-",
      "wo--rk",
      " work",
      "a".repeat(33),
    ];
    for (const id of valid) {
      expect(connectorAccountIdSchema.safeParse(id).success).toBe(true);
      expect(oauthGrantKey("borg.channel.m365", id)).toBe(
        id === DEFAULT_CONNECTOR_ACCOUNT_ID
          ? "borg.channel.m365"
          : `borg.channel.m365.${id}`,
      );
    }
    for (const id of invalid) {
      expect(connectorAccountIdSchema.safeParse(id).success).toBe(false);
      expect(() => oauthGrantKey("borg.channel.m365", id)).toThrow(
        "Connector account id is invalid",
      );
      expect(() => connectorAdapterId("borg.channel.slack", id)).toThrow(
        "Connector account id is invalid",
      );
      expect(() => connectorSecretKey(id, "botToken")).toThrow(
        "Connector account id is invalid",
      );
      expect(() => connectorStoreKey(id, "cursor")).toThrow(
        "Connector account id is invalid",
      );
    }
  });
});
