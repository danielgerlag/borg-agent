import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const allowed = new Map([
  [
    "plugins/graphs/src/field-renderer.tsx",
    "For keys KindDescriptor FieldSpec objects from the registry, not per-keystroke row objects",
  ],
]);

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

function isForOpen(source, index) {
  return source.startsWith("<For", index) && /[\s>]/.test(source[index + 4] ?? "");
}

function forBlocks(source) {
  const blocks = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const start = source.indexOf("<For", searchFrom);
    if (start === -1) {
      break;
    }
    if (!isForOpen(source, start)) {
      searchFrom = start + 4;
      continue;
    }
    let depth = 1;
    let i = start + 4;
    let end = -1;
    while (i < source.length) {
      const nextOpen = source.indexOf("<For", i);
      const nextClose = source.indexOf("</For>", i);
      if (nextClose === -1) {
        break;
      }
      if (nextOpen !== -1 && nextOpen < nextClose && isForOpen(source, nextOpen)) {
        depth += 1;
        i = nextOpen + 4;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        end = nextClose + 6;
        break;
      }
      i = nextClose + 6;
    }
    if (end === -1) {
      searchFrom = start + 4;
      continue;
    }
    blocks.push(source.slice(start, end));
    searchFrom = end;
  }
  return blocks;
}

const listAll = process.argv.includes("--all");
const flagged = [];
for (const file of walk(path.join(root, "apps")).concat(
  walk(path.join(root, "plugins")),
)) {
  const rel = path.relative(root, file);
  const source = readFileSync(file, "utf8");
  const hits = forBlocks(source).filter((block) => block.includes("onInput"));
  if (hits.length === 0) {
    continue;
  }
  const reason = allowed.get(rel);
  if (reason) {
    if (listAll) {
      console.log(`${rel}: allowed (${reason})`);
    }
    continue;
  }
  flagged.push(`${rel}: <For> block writes onInput (${hits.length})`);
}

if (flagged.length > 0) {
  console.error("Editable lists must use <Index>, not <For>.");
  console.error(
    "For keys by object identity and remounts the input on each keystroke.",
  );
  for (const line of flagged) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}
