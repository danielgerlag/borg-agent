import { describe, expect, it } from "vitest";
import {
  slackChannelDisconnect,
  slackChannelGetStatus,
  slackChannelStatusSchema,
  slackChannelVerify,
  slackSocketStateSchema,
} from "../src/index";

describe("slack channel commands", () => {
  it("exports Slack commands after Discord with a 30s verify timeout", () => {
    expect(slackChannelGetStatus.id).toBe("borg.channel.slack.getStatus");
    expect(slackChannelVerify.id).toBe("borg.channel.slack.verify");
    expect(slackChannelDisconnect.id).toBe("borg.channel.slack.disconnect");
    expect(slackChannelVerify.timeoutMs).toBe(30_000);
  });

  it("parses status without secret fields", () => {
    for (const state of ["idle", "connecting", "ready", "backoff", "fatal"] as const) {
      expect(slackSocketStateSchema.parse(state)).toBe(state);
    }
    expect(
      slackChannelGetStatus.output.parse({
        hasBotToken: true,
        hasAppToken: true,
        connected: true,
        botUserId: "U0123456789",
        socketState: "ready",
      }),
    ).toEqual({
      hasBotToken: true,
      hasAppToken: true,
      connected: true,
      botUserId: "U0123456789",
      socketState: "ready",
    });
    expect(() =>
      slackChannelStatusSchema.parse({
        hasBotToken: true,
        hasAppToken: true,
        connected: false,
        socketState: "idle",
        botToken: "xoxb-leak",
      }),
    ).toThrow();
    expect(() =>
      slackChannelStatusSchema.parse({
        hasBotToken: true,
        hasAppToken: true,
        connected: false,
        socketState: "identifying",
      }),
    ).toThrow();
  });
});
