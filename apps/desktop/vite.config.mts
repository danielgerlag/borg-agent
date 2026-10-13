import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDirectory, "../..");

function cjsDependencyEntries(): string[] {
  const desktop = JSON.parse(
    readFileSync(path.join(appDirectory, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const entries: string[] = [];
  for (const name of Object.keys(desktop.dependencies ?? {})) {
    if (
      (!name.startsWith("@borg/") && !name.startsWith("@borg-agent/")) ||
      name === "@borg-agent/kernel" ||
      name.startsWith("@borg/distribution-")
    ) {
      continue;
    }
    const manifestPath = path.join(appDirectory, "node_modules", name, "package.json");
    let manifest: { main?: string; exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        main?: string;
        exports?: Record<string, unknown>;
      };
    } catch {
      continue;
    }
    const manifestExports = manifest.exports;
    if (typeof manifestExports === "object" && manifestExports !== null) {
      for (const [subpath, target] of Object.entries(manifestExports)) {
        if (subpath === "./main" || typeof target !== "string" || !target.endsWith(".js")) {
          continue;
        }
        entries.push(subpath === "." ? name : `${name}${subpath.slice(1)}`);
      }
      continue;
    }
    if (typeof manifest.main === "string" && manifest.main.endsWith(".js")) {
      entries.push(name);
    }
  }
  return entries;
}

export default defineConfig(({ command }) => ({
  root: path.resolve(appDirectory, "src/renderer"),
  base: command === "serve" ? "/" : "./",
  plugins: [
    solid(),
    tailwindcss(),
    {
      name: "borg-dev-csp",
      transformIndexHtml(html) {
        if (command !== "serve") {
          return html;
        }
        return html.replace("connect-src 'none'", "connect-src 'self'");
      },
    },
  ],
  ...(command === "serve"
    ? { optimizeDeps: { include: cjsDependencyEntries() } }
    : {}),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
    watch: {
      followSymlinks: true,
    },
  },
  build: {
    outDir: path.resolve(appDirectory, "dist/renderer"),
    emptyOutDir: true,
  },
}));
