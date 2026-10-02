import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(appDirectory, "src/renderer"),
  base: "./",
  plugins: [solid(), tailwindcss()],
  build: {
    outDir: path.resolve(appDirectory, "dist/renderer"),
    emptyOutDir: true,
  },
});
