import { describe, expect, it, vi } from "vitest";
import { NotificationService } from "../src";

describe("NotificationService", () => {
  it("validates plugin requests before publishing them", async () => {
    const subscriber = vi.fn();
    const service = new NotificationService();
    service.subscribe(subscriber);

    await expect(
      service.notify("test.plugin", {
        title: "",
        body: "invalid",
      }),
    ).rejects.toThrow(/validation/);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("isolates subscriber and native notifier failures", async () => {
    const service = new NotificationService(() => {
      throw new Error("native failed");
    });
    service.subscribe(() => {
      throw new Error("subscriber failed");
    });

    await expect(
      service.notify("test.plugin", {
        title: "Still safe",
        body: "Failures stay isolated.",
        os: true,
      }),
    ).resolves.toBeUndefined();
  });
});
