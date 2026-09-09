import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const allowedTypes = new Set(["range", "color", "file", "hidden"]);

const tagPattern = /<(input|textarea|select|details)\b([^>]*)>/g;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function isAllowedInput(attrs) {
  const type = /type=["']([^"']+)["']/.exec(attrs)?.[1];
  return type !== undefined && allowedTypes.has(type);
}

const flagged = [];
for (const file of walk(path.join(root, "apps")).concat(
  walk(path.join(root, "plugins")),
)) {
  const source = readFileSync(file, "utf8");
  const relative = path.relative(root, file);
  for (const match of source.matchAll(tagPattern)) {
    const tag = match[1];
    const attrs = match[2] ?? "";
    if (tag === "input" && isAllowedInput(attrs)) {
      continue;
    }
    const before = source.slice(0, match.index ?? 0);
    const line = before.split("\n").length;
    flagged.push(`${relative}:${line} native <${tag}>`);
  }
}

if (flagged.length > 0) {
  console.error(
    "Native form controls remain. Use @borg/ui-kit TextField, Checkbox, Switch, Select, Dialog, or Collapsible.\nAllowed native inputs: type=range|color|file|hidden.\n",
  );
  for (const item of flagged) {
    console.error(`  ${item}`);
  }
  process.exit(1);
}
