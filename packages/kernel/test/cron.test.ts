import { describe, expect, it } from "vitest";
import { nextCronOccurrence, parseCron } from "../src/cron";

describe("cron", () => {
  it("parses a five-field expression", () => {
    const cron = parseCron("*/5 9-17 * * 1-5");
    expect(cron.minute.has(0)).toBe(true);
    expect(cron.minute.has(5)).toBe(true);
    expect(cron.minute.has(1)).toBe(false);
    expect(cron.hour.has(9)).toBe(true);
    expect(cron.hour.has(17)).toBe(true);
    expect(cron.hour.has(8)).toBe(false);
    expect(cron.weekday.has(1)).toBe(true);
    expect(cron.weekday.has(0)).toBe(false);
    expect(cron.dayRestricted).toBe(false);
    expect(cron.weekdayRestricted).toBe(true);
  });

  it("treats weekday 7 as Sunday", () => {
    const cron = parseCron("0 0 * * 7");
    expect(cron.weekday.has(0)).toBe(true);
    expect(cron.weekday.has(7)).toBe(false);
  });

  it("rejects expressions that are not five fields", () => {
    expect(() => parseCron("* * * *")).toThrow("five fields");
  });

  it("finds the next UTC minute that matches", () => {
    const from = Date.parse("2026-09-03T17:00:30.000Z");
    expect(nextCronOccurrence("1 17 * * *", from)).toBe(
      Date.parse("2026-09-03T17:01:00.000Z"),
    );
    expect(nextCronOccurrence("0 18 * * *", from)).toBe(
      Date.parse("2026-09-03T18:00:00.000Z"),
    );
  });
});
