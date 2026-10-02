#!/usr/bin/env node
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";
import solid from "vite-plugin-solid";

const root = path.resolve(process.cwd(), "src/renderer");

await build({
  root,
  base: "./",
  plugins: [solid(), tailwindcss()],
  build: {
    outDir: path.resolve(process.cwd(), "dist/renderer"),
    emptyOutDir: true,
  },
});
