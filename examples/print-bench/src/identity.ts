import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const printBenchAppName = "Print bench";
const legacyElectronHostName = "Electron";

export function isolatedPrintBenchHome(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.BORG_PRINT_BENCH_HOME?.trim();
  return home ? home : undefined;
}

interface PrintBenchHost {
  setName(name: string): void;
  setPath(name: string, folder: string): void;
  getPath(name: "userData" | "appData"): string;
}

export function preparePrintBenchHost(application: PrintBenchHost, env: NodeJS.ProcessEnv): void {
  const isolatedHome = isolatedPrintBenchHome(env);
  application.setName(printBenchAppName);
  if (isolatedHome) {
    application.setPath("userData", isolatedHome);
    return;
  }
  // Earlier launches stored this window's data under the Electron binary's name.
  const currentPlugins = join(application.getPath("userData"), "plugins");
  const legacyPlugins = join(application.getPath("appData"), legacyElectronHostName, "plugins");
  if (existsSync(currentPlugins) || !existsSync(legacyPlugins)) {
    return;
  }
  mkdirSync(application.getPath("userData"), { recursive: true });
  cpSync(legacyPlugins, currentPlugins, { recursive: true });
}
