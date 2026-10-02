import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import config from "./vite.config.mts";

const here = dirname(fileURLToPath(import.meta.url));

await build({ ...config, configFile: false });
await mkdir(join(here, "dist"), { recursive: true });
await copyFile(join(here, "src/preload.cjs"), join(here, "dist/preload.cjs"));
