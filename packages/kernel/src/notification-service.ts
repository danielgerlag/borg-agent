import type { Disposable, NotificationRequest } from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";

export interface KernelNotification {
  readonly id: string;
  readonly sourcePluginId: string;
  readonly title: string;
  readonly body: string;
  readonly level: "info" | "success" | "warning" | "error";
  readonly createdAt: string;
}

export type OsNotificationHandler = (
  notification: KernelNotification,
) => void | Promise<void>;

export class NotificationService {
  readonly #subscribers = new Map<
    symbol,
    (notification: KernelNotification) => void | Promise<void>
  >();

  constructor(readonly showOsNotification?: OsNotificationHandler) {}

  async notify(sourcePluginId: string, request: NotificationRequest): Promise<void> {
    if (
      typeof request.title !== "string" ||
      request.title.length === 0 ||
      request.title.length > 100 ||
      typeof request.body !== "string" ||
      request.body.length > 500 ||
      (request.level !== undefined &&
        !["info", "success", "warning", "error"].includes(request.level)) ||
      (request.os !== undefined && typeof request.os !== "boolean")
    ) {
      throw new Error("Notification request failed validation");
    }

    const notification: KernelNotification = {
      id: randomUUID(),
      sourcePluginId,
      title: request.title,
      body: request.body,
      level: request.level ?? "info",
      createdAt: new Date().toISOString(),
    };

    const work = [
      ...[...this.#subscribers.values()].map(
        async (subscriber) => subscriber(notification),
      ),
      ...(request.os === true && this.showOsNotification
        ? [Promise.resolve().then(async () => this.showOsNotification?.(notification))]
        : []),
    ];
    await Promise.allSettled(work);
  }

  subscribe(
    subscriber: (notification: KernelNotification) => void | Promise<void>,
  ): Disposable {
    const token = Symbol("notification");
    this.#subscribers.set(token, subscriber);
    return {
      dispose: () => {
        this.#subscribers.delete(token);
      },
    };
  }
}
