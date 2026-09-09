import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  MAX_CONNECTOR_ACCOUNTS,
  CONNECTOR_ACCOUNT_ID_MAX,
  CONNECTOR_ACCOUNT_NAME_MAX,
  allocateConnectorAccountId,
  connectorAdapterId,
  connectorSecretKey,
  connectorStoreKey,
  oauthGrantKey,
  slugifyConnectorAccountName,
} from "../src/index";

describe("connector account helpers", () => {
  it("exposes the shared bounds", () => {
    expect(DEFAULT_CONNECTOR_ACCOUNT_ID).toBe("default");
    expect(MAX_CONNECTOR_ACCOUNTS).toBe(8);
    expect(CONNECTOR_ACCOUNT_ID_MAX).toBe(32);
    expect(CONNECTOR_ACCOUNT_NAME_MAX).toBe(80);
  });

  it("leaves default and empty account ids unprefixed", () => {
    expect(connectorAdapterId("borg.channel.slack", "default")).toBe(
      "borg.channel.slack",
    );
    expect(connectorAdapterId("borg.channel.slack", "")).toBe(
      "borg.channel.slack",
    );
    expect(connectorSecretKey("default", "botToken")).toBe("botToken");
    expect(connectorSecretKey("", "appToken")).toBe("appToken");
    expect(connectorStoreKey("default", "cursor")).toBe("cursor");
    expect(oauthGrantKey("borg.channel.m365")).toBe("borg.channel.m365");
    expect(oauthGrantKey("borg.channel.m365", "default")).toBe(
      "borg.channel.m365",
    );
    expect(oauthGrantKey("borg.channel.m365", "")).toBe("borg.channel.m365");
  });

  it("prefixes extra account ids and rejects invalid ones", () => {
    expect(connectorAdapterId("borg.channel.slack", "work")).toBe(
      "borg.channel.slack.work",
    );
    expect(connectorSecretKey("work", "botToken")).toBe("work.botToken");
    expect(connectorStoreKey("work", "cursor")).toBe("work/cursor");
    expect(oauthGrantKey("borg.channel.m365", "work")).toBe(
      "borg.channel.m365.work",
    );
    expect(() => connectorAdapterId("borg.channel.slack", "Work")).toThrow(
      "Connector account id is invalid",
    );
    expect(() => connectorSecretKey("work_space", "botToken")).toThrow(
      "Connector account id is invalid",
    );
    expect(() => oauthGrantKey("borg.channel.m365", "a".repeat(33))).toThrow(
      "Connector account id is invalid",
    );
  });

  it("slugifies names and never mints default", () => {
    expect(slugifyConnectorAccountName(" Work Workspace ")).toBe(
      "work-workspace",
    );
    expect(allocateConnectorAccountId("Work", [])).toBe("work");
    expect(allocateConnectorAccountId("Default", [])).toBe("default-2");
    expect(allocateConnectorAccountId("@@@", [])).toBe("account");
    expect(allocateConnectorAccountId("Work", ["work"])).toBe("work-2");
    expect(allocateConnectorAccountId("Work", ["work", "work-2"])).toBe(
      "work-3",
    );
  });
});
