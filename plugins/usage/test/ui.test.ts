import { describe, expect, it } from "vitest";
import { formatCurrencyAmounts } from "../src/format";

describe("usage formatting", () => {
  it("keeps currencies separate", () => {
    expect(formatCurrencyAmounts({ USD: 0.0123, EUR: 0.04 })).toBe(
      "USD 0.0123 + EUR 0.0400",
    );
    expect(formatCurrencyAmounts({})).toBe("no cost");
  });
});
