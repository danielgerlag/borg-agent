import path from "node:path";

/** Reference app. Its profile stays at Electron's default user-data path. */
export const REFERENCE_DISTRIBUTION_ID = "borg.desktop";

const distributionDirectoryName = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/;

export function argvRequestsUserDataDir(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--user-data-dir" ||
      arg === "-user-data-dir" ||
      arg.startsWith("--user-data-dir=") ||
      arg.startsWith("-user-data-dir="),
  );
}

/**
 * Profile directory for a workplace other than borg.desktop.
 * Undefined means leave Electron's user-data path alone.
 */
export function userDataDirectoryForDistribution(options: {
  readonly appData: string;
  readonly distributionId: string;
  readonly explicitUserDataDir: boolean;
}): string | undefined {
  if (options.explicitUserDataDir) {
    return undefined;
  }
  if (
    options.distributionId === REFERENCE_DISTRIBUTION_ID ||
    !distributionDirectoryName.test(options.distributionId)
  ) {
    return undefined;
  }
  return path.join(options.appData, options.distributionId);
}
