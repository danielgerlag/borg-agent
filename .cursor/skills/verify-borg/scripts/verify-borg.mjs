#!/usr/bin/env node
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../../../..");
const desktopApp = path.join(repoRoot, "apps/desktop");
const verifyRoot = path.join(repoRoot, ".verify-borg");
const currentFile = path.join(verifyRoot, "current");
const require = createRequire(path.join(desktopApp, "package.json"));

const PROVIDER_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
];

const OPTIONAL_SETUP_STEPS = [
  "openai-setup-step",
  "anthropic-setup-step",
  "azure-setup-step",
  "copilot-setup-step",
  "ollama-setup-step",
  "openrouter-setup-step",
];

const FEATURES = ["setup", "chat", "graphs", "bots", "themes"];
const CHAT_TEXT = "Hello from verification";
const CHAT_REPLY = `Mock reply: ${CHAT_TEXT}`;

function blockedElectronEnv(key) {
  return (
    key === "ELECTRON_RUN_AS_NODE" ||
    PROVIDER_ENV.includes(key) ||
    /^BORG_.+_ENDPOINT$/.test(key)
  );
}

function usage() {
  return `verify-borg launch [--run-id ID] [--display inherit]
verify-borg doctor [--run-id ID]
verify-borg drive <${FEATURES.join("|")}> [--run-id ID]
verify-borg cleanup [--run-id ID]
verify-borg run --feature <feature> [--run-id ID]
verify-borg click --testid ID [--timeout MS]
verify-borg click --role ROLE --name NAME
verify-borg fill --testid ID --value TEXT
verify-borg select --testid ID --value TEXT
verify-borg expect [--testid ID | --selector CSS | --role ROLE --name NAME] [--attr KEY=VALUE] [--visible] [--hidden] [--count N] [--contains TEXT] [--text TEXT] [--value TEXT] [--not-empty] [--contains-value TEXT] [--timeout MS]
verify-borg verify-dev-storage
verify-borg skip-optional-setup --until persona|ready
verify-borg screenshot --name NAME [--testid ID]
verify-borg snapshot --aria --name NAME [--testid ID] [--contains TEXT]
verify-borg side-effect --name NAME --contains TEXT [--namespace ID]
verify-borg profile-file --name NAME --path RELATIVE`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    const value = next === undefined || next.startsWith("--") ? true : rest[++index];
    if (key === "contains" || key === "attr") {
      flags[key] = [...(flags[key] ?? []), value];
    } else if (flags[key] !== undefined) {
      throw new Error(`duplicate flag --${key}`);
    } else {
      flags[key] = value;
    }
  }
  return { command, flags, positionals };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function pidAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function procText(pid, leaf) {
  return readFileSync(`/proc/${pid}/${leaf}`).toString("utf8");
}

function gitInfo() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const porcelain = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { head, dirty: porcelain.length > 0 };
}

function electronBinary() {
  return require(require.resolve("electron", { paths: [desktopApp] }));
}

function commandExists(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function newestMtime(directory, accept) {
  if (!existsSync(directory)) {
    return undefined;
  }
  let newest;
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        visit(full);
      } else if (accept(full) && (!newest || stats.mtimeMs > newest.mtimeMs)) {
        newest = { file: full, mtimeMs: stats.mtimeMs };
      }
    }
  };
  visit(directory);
  return newest;
}

function freshness(label, output, source) {
  if (!existsSync(output)) {
    return { ok: false, line: `fail ${label} missing ${path.relative(repoRoot, output)}` };
  }
  if (!source) {
    return { ok: true, line: `ok ${label} ${path.relative(repoRoot, output)}` };
  }
  const outputMtime = statSync(output).mtimeMs;
  if (outputMtime < source.mtimeMs) {
    return {
      ok: false,
      line: `fail ${label} ${path.relative(repoRoot, source.file)} is newer than ${path.relative(repoRoot, output)}`,
    };
  }
  return { ok: true, line: `ok ${label} ${path.relative(repoRoot, output)}` };
}

function buildReport() {
  const checks = [
    freshness(
      "desktop main",
      path.join(desktopApp, "dist/main/index.js"),
      newestMtime(path.join(desktopApp, "src"), () => true),
    ),
    freshness(
      "desktop preload",
      path.join(desktopApp, "dist/preload/index.js"),
      newestMtime(path.join(desktopApp, "src/preload"), () => true),
    ),
    freshness(
      "desktop renderer",
      path.join(desktopApp, "dist/renderer/index.html"),
      newestMtime(path.join(desktopApp, "src/renderer"), () => true),
    ),
    freshness(
      "renderer ui",
      path.join(desktopApp, "dist/renderer/index.html"),
      newestMtime(path.join(repoRoot, "packages/ui-kit/src"), () => true),
    ),
    freshness(
      "kernel",
      path.join(repoRoot, "packages/kernel/dist/index.js"),
      newestMtime(path.join(repoRoot, "packages/kernel/src"), (file) => file.endsWith(".ts")),
    ),
    freshness(
      "contracts",
      path.join(repoRoot, "packages/contracts/dist/index.js"),
      newestMtime(path.join(repoRoot, "packages/contracts/src"), (file) => file.endsWith(".ts")),
    ),
    freshness(
      "plugin sdk",
      path.join(repoRoot, "packages/plugin-sdk/dist/index.js"),
      newestMtime(path.join(repoRoot, "packages/plugin-sdk/src"), (file) => file.endsWith(".ts")),
    ),
    freshness(
      "desktop distribution",
      path.join(repoRoot, "distributions/desktop/dist/index.js"),
      newestMtime(path.join(repoRoot, "distributions/desktop/src"), () => true),
    ),
  ];
  let uiSources;
  for (const name of readdirSync(path.join(repoRoot, "plugins"))) {
    const pluginRoot = path.join(repoRoot, "plugins", name);
    const mainDist = path.join(pluginRoot, "dist/main.js");
    if (existsSync(mainDist)) {
      checks.push(
        freshness(
          `plugin ${name} main`,
          mainDist,
          newestMtime(path.join(pluginRoot, "src"), (file) => file.endsWith(".ts")),
        ),
      );
    }
    const ui = newestMtime(path.join(pluginRoot, "src"), (file) => file.endsWith(".tsx"));
    if (ui && (!uiSources || ui.mtimeMs > uiSources.mtimeMs)) {
      uiSources = ui;
    }
  }
  checks.push(
    freshness(
      "renderer plugins",
      path.join(desktopApp, "dist/renderer/index.html"),
      uiSources,
    ),
  );
  return {
    ok: checks.every((check) => check.ok),
    lines: checks.map((check) => check.line),
  };
}

function runDirFor(runId) {
  return path.join(verifyRoot, runId);
}

function statePath(runId) {
  return path.join(runDirFor(runId), "state.json");
}

function resolveRunId(flags) {
  if (typeof flags["run-id"] === "string") {
    return flags["run-id"];
  }
  if (!existsSync(currentFile)) {
    throw new Error("no current run. launch first or pass --run-id");
  }
  return readFileSync(currentFile, "utf8").trim();
}

function loadState(flags) {
  const runId = resolveRunId(flags);
  const file = statePath(runId);
  if (!existsSync(file)) {
    throw new Error(`missing state for run ${runId}`);
  }
  return readJson(file);
}

function saveState(state) {
  writeJson(statePath(state.runId), state);
}

function appendLog(state, entry) {
  const file = path.join(state.runDir, "actions.jsonl");
  mkdirSync(state.runDir, { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}

function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function displaySocket(display) {
  const match = /^:(\d+)/.exec(display ?? "");
  if (!match) {
    return undefined;
  }
  return `/tmp/.X11-unix/X${match[1]}`;
}

function cssValue(value) {
  const text = String(value);
  if (/["\\\]\n]/.test(text)) {
    throw new Error(`unsupported selector value ${text}`);
  }
  return text;
}

function locatorFor(page, flags) {
  if (flags.role) {
    const options = flags.name ? { name: String(flags.name) } : undefined;
    return page.getByRole(String(flags.role), options);
  }
  if (flags.selector) {
    return page.locator(String(flags.selector));
  }
  if (flags.testid || flags.attr) {
    let css = flags.testid ? `[data-testid="${cssValue(flags.testid)}"]` : "";
    for (const attr of flags.attr ?? []) {
      const eq = String(attr).indexOf("=");
      if (eq <= 0) {
        throw new Error(`bad --attr ${attr}`);
      }
      css += `[${cssValue(attr.slice(0, eq))}="${cssValue(attr.slice(eq + 1))}"]`;
    }
    return page.locator(css);
  }
  return page.locator("body");
}

function evidenceFile(state, name, suffix) {
  if (!name || /[\\/]/.test(String(name))) {
    throw new Error("--name must be a single path segment");
  }
  const directory = path.join(state.runDir, "evidence");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${name}${suffix}`);
}

async function until(timeoutMs, check) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result === true) {
        return;
      }
      last = result;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(String(last));
}

async function runExpect(page, flags) {
  const timeout = Number(flags.timeout ?? 8_000);
  let locator = locatorFor(page, flags);
  for (const needle of flags.contains ?? []) {
    locator = locator.filter({ hasText: String(needle) });
  }
  if (flags.count !== undefined) {
    const wanted = Number(flags.count);
    await until(timeout, async () => {
      const count = await locator.count();
      return count === wanted ? true : `count ${count}, wanted ${wanted}`;
    });
    if (wanted === 0) {
      return "count 0";
    }
  }
  if (flags.hidden) {
    await until(timeout, async () => {
      const count = await locator.count();
      if (count === 0) {
        return true;
      }
      return (await locator.first().isHidden()) ? true : "still visible";
    });
    return "hidden";
  }
  if (
    flags["not-empty"] ||
    flags.value !== undefined ||
    flags["contains-value"]
  ) {
    await until(timeout, async () => {
      const value = await locator.inputValue();
      if (flags["not-empty"] && value === "") {
        return "empty value";
      }
      if (flags.value !== undefined && value !== flags.value) {
        return `value ${JSON.stringify(value)}`;
      }
      if (
        flags["contains-value"] &&
        !value.includes(String(flags["contains-value"]))
      ) {
        return `value ${JSON.stringify(value)}`;
      }
      return true;
    });
    return "value ok";
  }
  if (flags.text !== undefined) {
    await until(timeout, async () => {
      const actual = (await locator.first().innerText()).replace(/\s+/g, " ").trim();
      return actual === flags.text ? true : `text ${JSON.stringify(actual)}`;
    });
    return `text ${flags.text}`;
  }
  await until(timeout, async () => ((await locator.first().isVisible()) ? true : "not visible"));
  return "visible";
}

async function runClick(page, flags) {
  const timeout = Number(flags.timeout ?? 15_000);
  await locatorFor(page, flags).click({ timeout });
  return flags.testid ?? `${flags.role} ${flags.name ?? ""}`.trim();
}

async function runFill(page, flags) {
  if (flags.value === undefined) {
    throw new Error("fill requires --value");
  }
  await locatorFor(page, flags).fill(String(flags.value), {
    timeout: Number(flags.timeout ?? 15_000),
  });
  return flags.testid ?? flags.selector;
}

async function runSelect(page, flags) {
  if (flags.value === undefined) {
    throw new Error("select requires --value");
  }
  // The themed Select keeps its test id on a visually hidden native <select>.
  await locatorFor(page, flags).selectOption(String(flags.value), {
    force: true,
    timeout: Number(flags.timeout ?? 15_000),
  });
  return `${flags.testid}=${flags.value}`;
}

async function verifyDevStorage(page) {
  const status = page.getByTestId("dev-secret-status");
  await status.waitFor({ timeout: 15_000 });
  const text = (await status.textContent()) ?? "";
  if (!text.includes("ready")) {
    await page.getByTestId("dev-secret-save").click({ timeout: 15_000 });
    await until(15_000, async () => {
      const next = (await status.textContent()) ?? "";
      return next.includes("storage is ready") ? true : next;
    });
  }
  return "dev storage ready";
}

async function skipOptionalSetup(page, untilTarget) {
  if (untilTarget !== "persona" && untilTarget !== "ready") {
    throw new Error("--until must be persona or ready");
  }
  const doneTestId = untilTarget === "persona" ? "wizard-persona-step" : "setup-ready";
  const done = page.getByTestId(doneTestId);
  let gate = done;
  for (const testId of OPTIONAL_SETUP_STEPS) {
    gate = gate.or(page.getByTestId(testId));
  }
  await gate.first().waitFor({ timeout: 20_000 });
  for (let remaining = OPTIONAL_SETUP_STEPS.length + 1; remaining > 0; remaining -= 1) {
    if (await done.isVisible()) {
      return doneTestId;
    }
    let skipped = false;
    for (const testId of OPTIONAL_SETUP_STEPS) {
      if (await page.getByTestId(testId).isVisible()) {
        await page.getByTestId("setup-continue").click({ timeout: 15_000 });
        skipped = true;
        break;
      }
    }
    if (!skipped) {
      break;
    }
  }
  if (!(await done.isVisible())) {
    throw new Error(`setup did not reach ${doneTestId}`);
  }
  return doneTestId;
}

async function runScreenshot(session, flags) {
  const page = session.page();
  const title = await page.title();
  if (title !== "Borg") {
    throw new Error(`page title ${JSON.stringify(title)}`);
  }
  const file = evidenceFile(session.state, flags.name, ".png");
  const target = flags.testid ? page.getByTestId(String(flags.testid)) : page;
  await target.screenshot({ path: file });
  return file;
}

async function runSnapshot(session, flags) {
  if (!flags.aria) {
    throw new Error("snapshot requires --aria");
  }
  const page = session.page();
  const target = flags.testid ? page.getByTestId(String(flags.testid)) : page.locator("body");
  await target.first().waitFor({ state: "visible", timeout: 15_000 });
  const snapshot = await target.ariaSnapshot();
  for (const needle of flags.contains ?? []) {
    if (!snapshot.includes(String(needle))) {
      throw new Error(`aria snapshot missing ${JSON.stringify(needle)}`);
    }
  }
  const file = evidenceFile(session.state, flags.name, ".aria.txt");
  writeFileSync(file, snapshot);
  return file;
}

function excerpt(value, needle) {
  const at = value.indexOf(needle);
  const start = Math.max(0, at - 24);
  return value.slice(start, at + needle.length + 24);
}

function queryStore(userDataDir, needles, namespace) {
  const file = path.join(userDataDir, "plugins", "borg.config.sqlite", "borg.sqlite3");
  const db = new DatabaseSync(file, { readOnly: true, timeout: 2_000 });
  try {
    const stored = db.prepare("SELECT namespace, key, value FROM plugin_store").all();
    const config = db.prepare("SELECT namespace, value FROM plugin_config").all();
    const rows = [
      ...stored.map((row) => ({
        table: "plugin_store",
        namespace: String(row.namespace),
        key: String(row.key),
        value: String(row.value),
      })),
      ...config.map((row) => ({
        table: "plugin_config",
        namespace: String(row.namespace),
        key: "",
        value: String(row.value),
      })),
    ];
    const hits = [];
    for (const needle of needles) {
      const match = rows.find(
        (row) =>
          (!namespace || row.namespace === namespace) && row.value.includes(needle),
      );
      if (!match) {
        throw new Error(
          `no ${namespace ?? "store"} row contains ${JSON.stringify(needle)}`,
        );
      }
      hits.push({
        table: match.table,
        namespace: match.namespace,
        key: match.key,
        excerpt: excerpt(match.value, needle),
      });
    }
    return hits;
  } finally {
    db.close();
  }
}

async function runSideEffect(session, flags) {
  const needles = (flags.contains ?? []).map(String);
  if (needles.length === 0) {
    throw new Error("side-effect requires --contains");
  }
  const namespace = flags.namespace ? String(flags.namespace) : undefined;
  let hits;
  let lastError = "sqlite unread";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      hits = queryStore(session.state.userDataDir, needles, namespace);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }
  if (!hits) {
    throw new Error(lastError);
  }
  const file = evidenceFile(session.state, flags.name, ".side-effect.json");
  const record = {
    runId: session.state.runId,
    userDataDir: session.state.userDataDir,
    namespace: namespace ?? null,
    hits,
  };
  writeJson(file, record);
  return file;
}

function runProfileFile(session, flags) {
  const relative = String(flags.path ?? "");
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error("--path must stay inside the disposable profile");
  }
  const full = path.join(session.state.userDataDir, relative);
  const stats = statSync(full);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`profile file ${relative} is missing`);
  }
  const file = evidenceFile(session.state, flags.name, ".profile-file.json");
  writeJson(file, {
    runId: session.state.runId,
    path: relative,
    bytes: stats.size,
    userDataDir: session.state.userDataDir,
  });
  return file;
}

async function dispatchPage(session, message) {
  const page = session.page();
  switch (message.cmd) {
    case "click":
      return runClick(page, message);
    case "fill":
      return runFill(page, message);
    case "select":
      return runSelect(page, message);
    case "expect":
      return runExpect(page, message);
    case "verify-dev-storage":
      return verifyDevStorage(page);
    case "skip-optional-setup":
      return skipOptionalSetup(page, message.until);
    case "screenshot":
      return runScreenshot(session, message);
    case "snapshot":
      return runSnapshot(session, message);
    case "side-effect":
      return runSideEffect(session, message);
    case "profile-file":
      return runProfileFile(session, message);
    default:
      throw new Error(`unknown page command ${message.cmd}`);
  }
}

async function runSteps(session, steps) {
  const done = [];
  for (const step of steps) {
    const summary = await dispatchPage(session, step);
    appendLog(session.state, { command: step.cmd, ok: true, step, summary });
    done.push({ cmd: step.cmd, summary });
  }
  return done;
}

function setupSteps() {
  return [
    { cmd: "expect", testid: "surface-wizard" },
    { cmd: "expect", testid: "setup-welcome" },
    { cmd: "click", testid: "setup-continue" },
    { cmd: "expect", testid: "dev-secrets-step" },
    { cmd: "verify-dev-storage" },
    { cmd: "click", testid: "setup-continue" },
    { cmd: "skip-optional-setup", until: "persona" },
    { cmd: "expect", testid: "wizard-persona-step" },
    {
      cmd: "expect",
      testid: "wizard-model-select",
      "contains-value": "borg.mock-llm",
      timeout: "15000",
    },
    { cmd: "click", testid: "setup-continue" },
    { cmd: "skip-optional-setup", until: "ready" },
    { cmd: "expect", testid: "setup-ready" },
    { cmd: "click", testid: "setup-complete" },
    { cmd: "expect", testid: "chat-workspace", timeout: "20000" },
    { cmd: "expect", testid: "chat-empty-state" },
    { cmd: "screenshot", name: "setup" },
    {
      cmd: "snapshot",
      aria: true,
      name: "setup",
      testid: "app-shell",
      contains: ["Borg", "What can we work on?"],
    },
    {
      cmd: "side-effect",
      name: "setup",
      namespace: "system.setup",
      contains: ['"wizardCompleted":true'],
    },
    {
      cmd: "profile-file",
      name: "setup-secrets",
      path: "plugins/borg.secrets.dev/secrets.json",
    },
  ];
}

function chatSteps() {
  return [
    { cmd: "expect", testid: "chat-empty-state" },
    {
      cmd: "expect",
      testid: "chat-session-list",
      contains: ["No saved chats yet"],
    },
    { cmd: "fill", testid: "chat-composer-input", value: CHAT_TEXT },
    { cmd: "expect", testid: "chat-composer-input", value: CHAT_TEXT },
    { cmd: "click", testid: "chat-send" },
    {
      cmd: "expect",
      testid: "chat-message",
      attr: ["data-role=user"],
      contains: [CHAT_TEXT],
      timeout: "20000",
    },
    {
      cmd: "expect",
      testid: "chat-message",
      attr: ["data-role=assistant"],
      contains: [CHAT_REPLY],
      timeout: "20000",
    },
    { cmd: "expect", testid: "chat-session-status", text: "Ready", timeout: "20000" },
    { cmd: "expect", testid: "chat-session-list", contains: [CHAT_TEXT] },
    {
      cmd: "expect",
      selector: '[data-testid^="chat-session-item-"]',
      count: "1",
    },
    { cmd: "expect", testid: "plugin-ui-error", count: "0" },
    { cmd: "screenshot", name: "chat" },
    {
      cmd: "snapshot",
      aria: true,
      name: "chat",
      testid: "app-shell",
      contains: ["Borg", CHAT_TEXT, CHAT_REPLY],
    },
    {
      cmd: "side-effect",
      name: "chat",
      namespace: "borg.chat",
      contains: [CHAT_TEXT, CHAT_REPLY],
    },
  ];
}

function graphSteps() {
  return [
    { cmd: "click", testid: "workspace-view-tab-borg.graphs.designer" },
    { cmd: "expect", testid: "graph-designer" },
    { cmd: "click", testid: "graph-create" },
    { cmd: "expect", testid: "graph-name", value: "Untitled graph" },
    { cmd: "fill", testid: "graph-name", value: "Verify graph" },
    { cmd: "fill", testid: "graph-description", value: "Saved by verification" },
    { cmd: "click", testid: "graph-save" },
    { cmd: "expect", testid: "graph-designer", contains: ["Graph saved."], timeout: "15000" },
    { cmd: "expect", testid: "graph-list", contains: ["Verify graph"] },
    { cmd: "screenshot", name: "graphs" },
    {
      cmd: "snapshot",
      aria: true,
      name: "graphs",
      testid: "app-shell",
      contains: ["Borg", "Verify graph"],
    },
    {
      cmd: "side-effect",
      name: "graphs",
      namespace: "borg.graphs",
      contains: ["Verify graph", "Saved by verification"],
    },
  ];
}

function botSteps() {
  return [
    { cmd: "click", testid: "workspace-view-tab-borg.bots.manager" },
    { cmd: "expect", testid: "bots-workspace" },
    { cmd: "expect", testid: "bot-list", contains: ["No bots yet"] },
    { cmd: "fill", testid: "bot-name", value: "Verify bot" },
    { cmd: "fill", testid: "bot-launch-prompt", value: "Say hello from verification" },
    { cmd: "click", testid: "bot-create" },
    { cmd: "expect", testid: "bot-detail-name", text: "Verify bot", timeout: "15000" },
    { cmd: "expect", testid: "bot-count", text: "1" },
    { cmd: "expect", testid: "bot-error", count: "0" },
    { cmd: "screenshot", name: "bots" },
    {
      cmd: "snapshot",
      aria: true,
      name: "bots",
      testid: "app-shell",
      contains: ["Borg", "Verify bot"],
    },
    {
      cmd: "side-effect",
      name: "bots",
      namespace: "borg.bots",
      contains: ["Verify bot", "Say hello from verification"],
    },
  ];
}

function themeSteps() {
  return [
    { cmd: "click", testid: "nav-settings" },
    { cmd: "expect", testid: "surface-settings" },
    { cmd: "click", testid: "settings-section-borg.themes.settings" },
    { cmd: "expect", testid: "themes-settings-page" },
    { cmd: "expect", testid: "themes-status", contains: ["Dark is the default."] },
    { cmd: "select", testid: "themes-select", value: "light" },
    { cmd: "click", testid: "themes-save" },
    { cmd: "expect", testid: "themes-status", text: "Light theme saved.", timeout: "15000" },
    { cmd: "expect", selector: 'html[data-theme="light"]', count: "1" },
    { cmd: "screenshot", name: "themes" },
    {
      cmd: "snapshot",
      aria: true,
      name: "themes",
      testid: "app-shell",
      contains: ["Borg", "Light theme saved."],
    },
    {
      cmd: "side-effect",
      name: "themes",
      namespace: "borg.themes",
      contains: ['"light"'],
    },
  ];
}

const RECIPES = {
  setup: setupSteps,
  chat: chatSteps,
  graphs: graphSteps,
  bots: botSteps,
  themes: themeSteps,
};

async function ensureWorkspace(session) {
  const page = session.page();
  if (await page.getByTestId("surface-wizard").isVisible()) {
    await runSteps(session, setupSteps());
  }
  await runSteps(session, [{ cmd: "expect", testid: "chat-workspace", timeout: "20000" }]);
}

async function driveFeature(session, feature) {
  if (!RECIPES[feature]) {
    throw new Error(`unknown feature ${feature}. expected ${FEATURES.join(", ")}`);
  }
  if (feature !== "setup") {
    await ensureWorkspace(session);
  }
  return runSteps(session, RECIPES[feature]());
}

function launchEnvironment(display, isolate) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !blockedElectronEnv(key)) {
      env[key] = value;
    }
  }
  env.BORG_E2E = "1";
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  if (display) {
    env.DISPLAY = display;
  }
  if (isolate) {
    delete env.WAYLAND_DISPLAY;
  }
  return env;
}

function useInheritedDisplay(state, source) {
  const display = process.env.DISPLAY;
  const socket = displaySocket(display);
  if (!display || !socket || !existsSync(socket)) {
    throw new Error(
      source === "inherit"
        ? "launch --display inherit needs a live DISPLAY socket"
        : "Xvfb is not on PATH and DISPLAY has no socket",
    );
  }
  state.display = display;
  state.xvfbPid = null;
  state.displaySource = source;
  saveState(state);
  return display;
}

async function startPrivateXvfb(state) {
  for (let number = 80; number < 120; number += 1) {
    const display = `:${number}`;
    const lock = `/tmp/.X${number}-lock`;
    if (existsSync(lock)) {
      continue;
    }
    const child = spawn(
      "Xvfb",
      [display, "-screen", "0", "1280x800x24", "-ac", "-nolisten", "tcp"],
      { stdio: "ignore" },
    );
    const started = Date.now();
    while (Date.now() - started < 3_000) {
      if (child.exitCode !== null) {
        break;
      }
      if (existsSync(lock)) {
        state.display = display;
        state.xvfbPid = child.pid;
        state.displaySource = "xvfb";
        saveState(state);
        return display;
      }
      await sleep(50);
    }
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  throw new Error("no free X display for Xvfb");
}

async function startXvfb(state) {
  const wantsPrivate = state.displayMode !== "inherit";
  if (wantsPrivate && commandExists("Xvfb")) {
    return startPrivateXvfb(state);
  }
  return useInheritedDisplay(state, wantsPrivate ? "fallback" : "inherit");
}

function releasePrivateDisplay(state) {
  if (state.displaySource !== "xvfb" || (state.xvfbPid && pidAlive(state.xvfbPid))) {
    return;
  }
  const match = /^:(\d+)/.exec(state.display ?? "");
  if (!match) {
    return;
  }
  const lock = `/tmp/.X${match[1]}-lock`;
  let owner;
  try {
    owner = Number(readFileSync(lock, "utf8").trim());
  } catch {
    return;
  }
  // Only remove a stale lock our own Xvfb left behind, never another server's.
  if (owner !== state.xvfbPid) {
    return;
  }
  rmSync(lock, { force: true });
  rmSync(`/tmp/.X11-unix/X${match[1]}`, { force: true });
}

async function waitForPid(pid, timeoutMs) {
  const started = Date.now();
  while (pidAlive(pid) && Date.now() - started < timeoutMs) {
    await sleep(100);
  }
}

async function stopElectron(session) {
  const pid = session.state.electronPid;
  try {
    await session.application.evaluate(({ app }) => {
      app.quit();
    });
  } catch {
    // The main process may already be gone.
  }
  await waitForPid(pid, 8_000);
  if (pidAlive(pid)) {
    process.kill(pid, "SIGTERM");
    await waitForPid(pid, 4_000);
  }
  if (pidAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForPid(pid, 2_000);
  }
  try {
    await session.application.close();
  } catch {
    // close() races with a process we already signalled.
  }
}

function createSession(application, state) {
  const hooked = new WeakSet();
  return {
    application,
    state,
    page() {
      const open = application.windows().filter((window) => !window.isClosed());
      if (open.length === 0) {
        throw new Error("Borg has no open window");
      }
      const page = open[0];
      if (!hooked.has(page)) {
        hooked.add(page);
        page.on("dialog", (dialog) => {
          appendLog(state, {
            command: "dialog",
            ok: false,
            message: dialog.message(),
          });
          dialog.dismiss().catch(() => {});
        });
        page.on("pageerror", (error) => {
          appendLog(state, { command: "pageerror", ok: false, error: error.message });
        });
      }
      return page;
    },
  };
}

async function probe(session) {
  return session.application.evaluate(() => {
    const api = globalThis.__borgTest;
    if (!api || typeof api.userDataPath !== "function") {
      return { ok: false, reason: "__borgTest.userDataPath is missing" };
    }
    return {
      ok: true,
      userDataPath: api.userDataPath(),
      activePluginIds: api.activePluginIds(),
    };
  });
}

let shuttingDown = false;

async function shutdown(session, reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  appendLog(session.state, { command: "shutdown", ok: true, reason });
  if (session.application) {
    await stopElectron(session);
  } else if (session.state.electronPid && pidAlive(session.state.electronPid)) {
    process.kill(session.state.electronPid, "SIGTERM");
    await waitForPid(session.state.electronPid, 4_000);
  }
  if (session.state.userDataDir && existsSync(session.state.userDataDir)) {
    rmSync(session.state.userDataDir, { recursive: true, force: true });
  }
  if (session.state.xvfbPid && pidAlive(session.state.xvfbPid)) {
    process.kill(session.state.xvfbPid, "SIGTERM");
    await waitForPid(session.state.xvfbPid, 2_000);
    if (pidAlive(session.state.xvfbPid)) {
      process.kill(session.state.xvfbPid, "SIGKILL");
    }
  }
  releasePrivateDisplay(session.state);
  session.server?.close();
  try {
    rmSync(session.state.socketPath, { force: true });
  } catch {
    // The socket is already gone.
  }
}

async function handleCommand(session, raw) {
  let message;
  try {
    message = JSON.parse(raw);
    if (message.cmd === "quit") {
      setTimeout(() => {
        void shutdown(session, "quit").then(() => process.exit(0));
      }, 100);
      return { ok: true, summary: "quitting" };
    }
    if (message.cmd === "probe") {
      const body = await probe(session);
      return { ok: true, body };
    }
    if (message.cmd === "drive") {
      const steps = await driveFeature(session, message.feature);
      return { ok: true, steps };
    }
    const summary = await dispatchPage(session, message);
    appendLog(session.state, { command: message.cmd, ok: true, step: message, summary });
    return { ok: true, summary };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    appendLog(session.state, {
      command: message?.cmd ?? "rpc",
      ok: false,
      error: text,
    });
    return { ok: false, error: text };
  }
}

function listen(session) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const raw = buffer.slice(0, newline);
      void handleCommand(session, raw).then((result) => {
        socket.end(`${JSON.stringify(result)}\n`);
      });
    });
  });
  session.server = server;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(session.state.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function serve() {
  const parsed = parseArgs(process.argv.slice(2));
  const state = loadState(parsed.flags);
  state.supervisorPid = process.pid;
  state.runDir = runDirFor(state.runId);
  saveState(state);
  const session = {
    application: undefined,
    state,
    server: undefined,
    page() {
      throw new Error("Borg is not launched");
    },
  };
  process.on("SIGTERM", () => {
    void shutdown(session, "SIGTERM").then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void shutdown(session, "SIGINT").then(() => process.exit(0));
  });
  try {
    mkdirSync(path.join(state.runDir, "evidence"), { recursive: true });
    const display = await startXvfb(state);
    const binary = electronBinary();
    state.electronPath = binary;
    saveState(state);
    if (!existsSync(binary)) {
      throw new Error(
        `electron binary missing at ${binary}. run node node_modules/electron/install.js`,
      );
    }
    const application = await electron.launch({
      executablePath: binary,
      args: [desktopApp, `--user-data-dir=${state.userDataDir}`],
      env: launchEnvironment(display, state.displaySource === "xvfb"),
      cwd: repoRoot,
      timeout: 90_000,
    });
    session.application = application;
    state.electronPid = application.process().pid;
    saveState(state);
    const live = createSession(application, state);
    session.page = () => live.page();
    await application.firstWindow({ timeout: 60_000 });
    const page = session.page();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("app-shell").waitFor({ timeout: 45_000 });
    const body = await probe(live);
    if (!body.ok) {
      throw new Error(body.reason);
    }
    if (!samePath(body.userDataPath, state.userDataDir)) {
      throw new Error(
        `userDataPath ${body.userDataPath} != disposable profile ${state.userDataDir}`,
      );
    }
    await listen(session);
    writeJson(path.join(state.runDir, "ready.json"), {
      runId: state.runId,
      electronPid: state.electronPid,
      userDataDir: state.userDataDir,
      display: state.display,
      displaySource: state.displaySource,
      xvfbPid: state.xvfbPid,
    });
    await new Promise(() => {});
  } catch (error) {
    const text = error instanceof Error ? error.stack ?? error.message : String(error);
    writeFileSync(path.join(state.runDir, "failed.json"), `${text}\n`);
    await shutdown(session, "boot-failed");
    process.exitCode = 1;
  }
}

function rpc(socketPath, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for ${message.cmd}`));
    }, timeoutMs);
    let buffer = "";
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      clearTimeout(timer);
      socket.end();
      const payload = JSON.parse(buffer.slice(0, newline));
      if (!payload.ok) {
        reject(new Error(payload.error || `${message.cmd} failed`));
        return;
      }
      resolve(payload);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
  });
}

async function waitForReady(state) {
  const ready = path.join(state.runDir, "ready.json");
  const failed = path.join(state.runDir, "failed.json");
  const logFile = path.join(state.runDir, "supervisor.log");
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    if (existsSync(ready)) {
      return readJson(ready);
    }
    if (existsSync(failed)) {
      throw new Error(readFileSync(failed, "utf8"));
    }
    const latest = readJson(statePath(state.runId));
    if (latest.supervisorPid && !pidAlive(latest.supervisorPid) && existsSync(logFile)) {
      throw new Error(readFileSync(logFile, "utf8").slice(-4000));
    }
    await sleep(200);
  }
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-4000) : "";
  throw new Error(`launch timed out\n${log}`);
}

async function launch(flags) {
  mkdirSync(verifyRoot, { recursive: true });
  if (existsSync(currentFile) && !flags["run-id"]) {
    const previous = readFileSync(currentFile, "utf8").trim();
    const previousState = path.join(verifyRoot, previous, "state.json");
    if (existsSync(previousState)) {
      const old = readJson(previousState);
      if (pidAlive(old.supervisorPid) || pidAlive(old.electronPid)) {
        throw new Error(
          `run ${previous} is still up. cleanup it, or launch --run-id <id> for a second instance`,
        );
      }
    }
  }
  const runId =
    typeof flags["run-id"] === "string"
      ? flags["run-id"]
      : `r${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
  if (!/^[\w.-]+$/.test(runId)) {
    throw new Error("run id must be a single path segment");
  }
  if (flags.display !== undefined && flags.display !== "inherit") {
    throw new Error("launch --display only accepts inherit");
  }
  const git = gitInfo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "borg-verify-"));
  const runDir = runDirFor(runId);
  mkdirSync(path.join(runDir, "evidence"), { recursive: true });
  const state = {
    runId,
    runDir,
    userDataDir,
    socketPath: path.join(runDir, "control.sock"),
    repoRoot,
    createdAt: new Date().toISOString(),
    gitHead: git.head,
    gitDirty: git.dirty,
    display: null,
    displayMode: flags.display === "inherit" ? "inherit" : "private",
    displaySource: null,
    xvfbPid: null,
    supervisorPid: null,
    electronPid: null,
    electronPath: null,
  };
  saveState(state);
  writeFileSync(currentFile, `${runId}\n`);
  const logFd = openSync(path.join(runDir, "supervisor.log"), "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--run-id", runId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: repoRoot,
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  try {
    const ready = await waitForReady(state);
    const latest = readJson(statePath(runId));
    console.log(`launch ${runId}`);
    console.log(`userDataDir ${latest.userDataDir}`);
    console.log(`electronPid ${ready.electronPid}`);
    console.log(`supervisorPid ${latest.supervisorPid}`);
    const source = latest.displaySource;
    const displayLine =
      source === "fallback"
        ? `${latest.display} fallback because Xvfb is not on PATH`
        : source === "inherit"
          ? `${latest.display} inherit`
          : `${latest.display} xvfb pid ${latest.xvfbPid}`;
    console.log(`display ${displayLine}`);
    console.log(`git ${latest.gitHead}`);
    console.log("ready");
    return 0;
  } catch (error) {
    await cleanup({ "run-id": runId }).catch(() => {});
    throw error;
  }
}

function doctorLines(state, probeBody) {
  const lines = [];
  let ok = true;
  const fail = (line) => {
    ok = false;
    lines.push(`fail ${line}`);
  };
  const pass = (line) => lines.push(`ok ${line}`);
  const build = buildReport();
  lines.push(...build.lines);
  if (!build.ok) {
    ok = false;
  }
  const binary = state.electronPath || electronBinary();
  try {
    statSync(binary);
    pass(`electron binary ${binary}`);
  } catch {
    fail(
      `electron binary missing ${binary}. run node node_modules/electron/install.js`,
    );
  }
  if (commandExists("Xvfb")) {
    pass("display tool Xvfb on PATH");
  } else if (process.env.DISPLAY) {
    pass(`display tool DISPLAY=${process.env.DISPLAY}`);
  } else {
    fail("display missing. Xvfb is not on PATH and DISPLAY is unset");
  }
  const socket = displaySocket(state.display);
  if (state.display && socket && existsSync(socket)) {
    pass(`instance display ${state.display}`);
  } else {
    fail(`instance display ${state.display ?? "unset"} has no socket`);
  }
  if (state.displaySource) {
    pass(`display source ${state.displaySource}`);
  }
  if (state.displaySource === "xvfb" && !state.xvfbPid) {
    fail("private Xvfb has no recorded pid");
  }
  if (state.xvfbPid) {
    if (pidAlive(state.xvfbPid)) {
      pass(`xvfb pid ${state.xvfbPid}`);
    } else {
      fail(`xvfb pid ${state.xvfbPid} is not alive`);
    }
  }
  const git = gitInfo();
  if (git.head === state.gitHead) {
    pass(`git HEAD ${git.head}`);
  } else {
    fail(`git HEAD ${git.head} differs from launch ${state.gitHead}`);
  }
  if (git.dirty) {
    lines.push("note git working tree is dirty");
  }
  if (!state.electronPid || !pidAlive(state.electronPid)) {
    fail(`electron pid ${state.electronPid ?? "missing"} is not alive`);
  } else {
    pass(`electron pid ${state.electronPid} alive`);
    try {
      const cmdline = procText(state.electronPid, "cmdline").split("\0").join(" ");
      if (cmdline.includes(state.userDataDir) && cmdline.includes(desktopApp)) {
        pass("electron cmdline is this run's app and profile");
      } else {
        fail(`electron cmdline does not match this run: ${cmdline}`);
      }
      const environ = procText(state.electronPid, "environ").split("\0");
      if (environ.includes("BORG_E2E=1")) {
        pass("BORG_E2E=1");
      } else {
        fail("BORG_E2E=1 is not in the electron environment");
      }
      const displayEntry = environ.find((entry) => entry.startsWith("DISPLAY="));
      const actualDisplay = displayEntry?.slice("DISPLAY=".length);
      if (actualDisplay === state.display) {
        pass(`electron DISPLAY ${actualDisplay}`);
      } else {
        fail(`electron DISPLAY ${actualDisplay ?? "unset"} != run display ${state.display}`);
      }
      const names = environ.map((entry) => {
        const eq = entry.indexOf("=");
        return eq === -1 ? entry : entry.slice(0, eq);
      });
      const leaked = [
        ...PROVIDER_ENV.filter((name) => names.includes(name)),
        ...names.filter((name) => /^BORG_.+_ENDPOINT$/.test(name)),
      ];
      if (leaked.length > 0) {
        fail(`electron environment contains ${leaked.join(", ")}`);
      } else {
        pass("electron environment has no provider keys or BORG_*_ENDPOINT overrides");
      }
    } catch (error) {
      fail(`proc read ${error instanceof Error ? error.message : error}`);
    }
  }
  const temporary = realpathSync(tmpdir());
  let profile = state.userDataDir;
  try {
    profile = realpathSync(state.userDataDir);
  } catch {
    fail(`user data dir missing ${state.userDataDir}`);
  }
  if (profile.startsWith(temporary) && path.basename(profile).startsWith("borg-verify-")) {
    pass(`disposable profile ${profile}`);
  } else {
    fail(`profile ${profile} is not a borg-verify directory under tmp`);
  }
  if (profile.startsWith(realpathSync(homedir()))) {
    fail("profile is inside the home directory");
  }
  if (!probeBody?.ok) {
    fail(probeBody?.reason ?? "probe failed");
  } else if (!samePath(probeBody.userDataPath, state.userDataDir)) {
    fail(
      `__borgTest.userDataPath ${probeBody.userDataPath} != ${state.userDataDir}`,
    );
  } else {
    pass(`__borgTest.userDataPath ${probeBody.userDataPath}`);
  }
  const plugins = probeBody?.activePluginIds ?? [];
  if (plugins.includes("borg.mock-llm")) {
    pass("borg.mock-llm active");
  } else {
    fail(`borg.mock-llm is not active (${plugins.join(", ")})`);
  }
  return { ok, lines };
}

async function doctor(flags) {
  const state = loadState(flags);
  let probeBody;
  try {
    probeBody = (await rpc(state.socketPath, { cmd: "probe" }, 20_000)).body;
  } catch (error) {
    probeBody = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const report = doctorLines(state, probeBody);
  const text = [`doctor ${state.runId}`, ...report.lines].join("\n");
  writeFileSync(path.join(state.runDir, "doctor.txt"), `${text}\n`);
  console.log(text);
  return report.ok ? 0 : 1;
}

async function forward(flags, message, timeoutMs) {
  const state = loadState(flags);
  const result = await rpc(state.socketPath, message, timeoutMs);
  if (result.summary) {
    console.log(`${message.cmd} ${result.summary}`);
  }
  if (result.steps) {
    for (const step of result.steps) {
      console.log(`${step.cmd} ${step.summary ?? ""}`.trim());
    }
  }
  return result;
}

async function drive(flags, feature) {
  if (!feature) {
    throw new Error(`drive requires a feature: ${FEATURES.join(", ")}`);
  }
  await forward(flags, { cmd: "drive", feature }, 180_000);
  const state = loadState(flags);
  console.log(`evidence ${path.join(state.runDir, "evidence")}`);
  return 0;
}

async function killRecorded(pid, label) {
  if (!pid) {
    return `${label} unset`;
  }
  if (!pidAlive(pid)) {
    return `${label} ${pid} already gone`;
  }
  process.kill(pid, "SIGTERM");
  await waitForPid(pid, 5_000);
  if (pidAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForPid(pid, 2_000);
  }
  return pidAlive(pid) ? `${label} ${pid} still alive` : `${label} ${pid} stopped`;
}

async function cleanup(flags) {
  const state = loadState(flags);
  let quit = "quit rpc not attempted";
  if (existsSync(state.socketPath)) {
    try {
      await rpc(state.socketPath, { cmd: "quit" }, 20_000);
      quit = "quit rpc accepted";
    } catch (error) {
      quit = `quit rpc failed: ${error instanceof Error ? error.message : error}`;
    }
  }
  await sleep(300);
  const lines = [
    quit,
    await killRecorded(state.electronPid, "electron"),
    await killRecorded(state.supervisorPid, "supervisor"),
    await killRecorded(state.xvfbPid, "xvfb"),
  ];
  releasePrivateDisplay(state);
  if (state.userDataDir && existsSync(state.userDataDir)) {
    rmSync(state.userDataDir, { recursive: true, force: true });
    lines.push(`removed profile ${state.userDataDir}`);
  } else {
    lines.push(`profile already gone ${state.userDataDir ?? ""}`.trim());
  }
  rmSync(state.socketPath, { force: true });
  writeJson(path.join(state.runDir, "cleanup.json"), {
    at: new Date().toISOString(),
    lines,
    evidence: path.join(state.runDir, "evidence"),
  });
  console.log(`cleanup ${state.runId}`);
  console.log(lines.join("\n"));
  console.log(`evidence ${path.join(state.runDir, "evidence")}`);
  const stuck = lines.some((line) => line.endsWith("still alive"));
  return stuck ? 1 : 0;
}

async function clientCommand(parsed) {
  const { command, flags, positionals } = parsed;
  if (
    [
      "click",
      "fill",
      "select",
      "expect",
      "verify-dev-storage",
      "skip-optional-setup",
      "screenshot",
      "snapshot",
      "side-effect",
      "profile-file",
    ].includes(command)
  ) {
    await forward(flags, { cmd: command, ...flags }, 40_000);
    return 0;
  }
  switch (command) {
    case "launch":
      return launch(flags);
    case "doctor":
      return doctor(flags);
    case "drive":
      return drive(flags, positionals[0]);
    case "cleanup":
      return cleanup(flags);
    case "run": {
      const feature = typeof flags.feature === "string" ? flags.feature : positionals[0];
      const code = await launch(flags);
      if (code !== 0) {
        return code;
      }
      const doctorCode = await doctor(flags);
      if (doctorCode !== 0) {
        await cleanup(flags);
        return doctorCode;
      }
      try {
        await drive(flags, feature);
      } catch (error) {
        await cleanup(flags);
        throw error;
      }
      return cleanup(flags);
    }
    default:
      throw new Error(`unknown command ${command ?? ""}\n${usage()}`);
  }
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.command || parsed.command === "help") {
  console.log(usage());
  process.exitCode = parsed.command ? 0 : 1;
} else if (parsed.command === "serve") {
  await serve();
} else {
  try {
    process.exitCode = await clientCommand(parsed);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
