export { CommandEventBus } from "./command-event-bus";
export { satisfiesBorgEngine } from "./engine-range";
export { CommandInvocationError, PluginLoadError } from "./errors";
export {
  NotificationService,
  type KernelNotification,
  type OsNotificationHandler,
} from "./notification-service";
export {
  ConfigFacade,
  PersistenceRegistry,
  SecretFacade,
  StoreFacade,
} from "./persistence";
export {
  PluginManager,
  type ActivePluginMetadata,
  type PluginManagerOptions,
  type PluginRecord,
  type PluginSource,
  type PluginStatus,
} from "./plugin-manager";
