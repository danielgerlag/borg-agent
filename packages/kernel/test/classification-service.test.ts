import { describe, expect, it } from "vitest";
import {
  CAPACITY_CEILINGS,
  CLASSIFICATION_ORDER,
  ClassificationService,
  capacityCeiling,
  classificationRank,
  compareClassification,
  exceedsCapacity,
  maxClassification,
} from "../src/classification-service";

describe("ClassificationService order and ceilings", () => {
  it("orders classifications explicitly, not alphabetically", () => {
    expect([...CLASSIFICATION_ORDER]).toEqual([
      "public",
      "internal",
      "confidential",
      "restricted",
    ]);
    expect(classificationRank("public")).toBe(0);
    expect(classificationRank("restricted")).toBe(3);
    expect(compareClassification("internal", "confidential")).toBeLessThan(0);
    expect(compareClassification("restricted", "public")).toBeGreaterThan(0);
    expect(compareClassification("internal", "internal")).toBe(0);
    expect(maxClassification("public", "confidential", "internal")).toBe(
      "confidential",
    );
    expect(maxClassification()).toBe("public");
  });

  it("maps every channel capacity to an explicit ceiling", () => {
    expect({ ...CAPACITY_CEILINGS }).toEqual({
      public: "public",
      internal: "internal",
      private: "confidential",
      "local-only": "restricted",
    });
    expect(capacityCeiling("private")).toBe("confidential");

    expect(exceedsCapacity("public", "public")).toBe(false);
    expect(exceedsCapacity("internal", "public")).toBe(true);
    expect(exceedsCapacity("internal", "internal")).toBe(false);
    expect(exceedsCapacity("confidential", "internal")).toBe(true);
    expect(exceedsCapacity("confidential", "private")).toBe(false);
    expect(exceedsCapacity("restricted", "private")).toBe(true);
    expect(exceedsCapacity("restricted", "local-only")).toBe(false);
  });

  it("rejects unknown levels and capacities", () => {
    expect(() =>
      classificationRank("secret" as unknown as "public"),
    ).toThrow(/unknown/);
    expect(() =>
      capacityCeiling("carrier-pigeon" as unknown as "public"),
    ).toThrow(/unknown/);
    const service = new ClassificationService();
    expect(() => service.openRun("run-a", "secret" as unknown as "public")).toThrow(
      /invalid/,
    );
    service.openRun("run-b");
    expect(() =>
      service.raise("run-b", "secret" as unknown as "public", "why"),
    ).toThrow(/invalid/);
    expect(() => service.ceilingFor("nope" as unknown as "public")).toThrow(
      /invalid/,
    );
  });
});

describe("ClassificationService run watermarks", () => {
  it("keeps a versioned monotonic high-water mark per run", () => {
    const service = new ClassificationService();
    service.openRun("run-a");
    expect(service.snapshot("run-a")).toEqual({ level: "internal", version: 1 });

    expect(service.raise("run-a", "public", "downgrade attempt")).toEqual({
      level: "internal",
      version: 1,
    });
    expect(service.raise("run-a", "internal", "same level")).toEqual({
      level: "internal",
      version: 1,
    });
    expect(service.raise("run-a", "confidential", "read a secret")).toEqual({
      level: "confidential",
      version: 2,
    });
    expect(service.raise("run-a", "internal", "later tool")).toEqual({
      level: "confidential",
      version: 2,
    });
    expect(service.raise("run-a", "restricted", "local secret")).toEqual({
      level: "restricted",
      version: 3,
    });
    expect(service.history("run-a")).toEqual([
      { level: "confidential", version: 2, reason: "read a secret" },
      { level: "restricted", version: 3, reason: "local secret" },
    ]);
  });

  it("honours an explicit initial level and isolates runs", () => {
    const service = new ClassificationService();
    service.openRun("run-public", "public");
    service.openRun("run-restricted", "restricted");
    expect(service.snapshot("run-public")).toEqual({
      level: "public",
      version: 1,
    });
    service.raise("run-public", "confidential", "tool output");
    expect(service.snapshot("run-public")).toEqual({
      level: "confidential",
      version: 2,
    });
    expect(service.snapshot("run-restricted")).toEqual({
      level: "restricted",
      version: 1,
    });
  });

  it("treats callers without an open run as unclassified", () => {
    const service = new ClassificationService();
    expect(service.snapshot()).toEqual({ level: "public", version: 0 });
    expect(service.snapshot("missing")).toEqual({ level: "public", version: 0 });
    expect(service.raise("missing", "restricted", "no run")).toEqual({
      level: "public",
      version: 0,
    });
    expect(service.isOpen("missing")).toBe(false);
    expect(service.history("missing")).toEqual([]);
  });

  it("cleans a run up on disposal and keeps no durable state", () => {
    const service = new ClassificationService();
    const run = service.openRun("run-a");
    service.raise("run-a", "restricted", "read a secret");
    expect(service.isOpen("run-a")).toBe(true);

    run.dispose();
    expect(service.isOpen("run-a")).toBe(false);
    expect(service.snapshot("run-a")).toEqual({ level: "public", version: 0 });
    expect(service.history("run-a")).toEqual([]);

    const reopened = service.openRun("run-a");
    expect(service.snapshot("run-a")).toEqual({ level: "internal", version: 1 });
    run.dispose();
    expect(service.isOpen("run-a")).toBe(true);
    reopened.dispose();
    expect(service.isOpen("run-a")).toBe(false);
  });

  it("refuses to open the same run twice", () => {
    const service = new ClassificationService();
    service.openRun("run-a");
    expect(() => service.openRun("run-a")).toThrow(/already open/);
    expect(() => service.openRun("")).toThrow(/invalid/);
  });
});
