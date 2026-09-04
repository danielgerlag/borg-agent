import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { completeSetup } from "./setup";

const projectRoot = path.resolve(__dirname, "../..");
const desktopApp = path.join(projectRoot, "apps/desktop");
const electronPath = require(
  require.resolve("electron", { paths: [desktopApp] }),
) as string;

const ECHO_TOOL_USE_ID = "call_e2e_echo";

let application: ElectronApplication | undefined;
let page: Page;
let profileDirectory: string;
let launchEnvironment: Record<string, string>;
let fixture: Server;
let fixturePort: number;
let capturedPosts: Record<string, unknown>[] = [];

function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Electron cleanup timed out")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeSse(response: ServerResponse, frames: readonly string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`${frames.join("\n\n")}\n\n`);
}

function textFrames(text: string): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })}`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 4 },
    })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ];
}

function echoToolFrames(): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 6, output_tokens: 0 } },
    })}`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: ECHO_TOOL_USE_ID,
        name: "tools_echo",
        input: {},
      },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"text":"hello slice 7"}',
      },
    })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 3 },
    })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ];
}

function startFixture(): Promise<void> {
  capturedPosts = [];
  fixture = createServer(async (request, response) => {
    const key = request.headers["x-api-key"];
    if (key !== "sk-ant-e2e") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "authentication_error" } }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/v1/models/claude-sonnet-5"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "claude-sonnet-5", type: "model" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/messages") {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as {
      readonly messages?: readonly {
        readonly content?: unknown;
      }[];
      readonly tools?: readonly { readonly name?: string }[];
    };
    capturedPosts.push(body);
    const last = body.messages?.at(-1);
    const hasToolResult =
      Array.isArray(last?.content) &&
      last.content.some(
        (block) =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { readonly type?: unknown }).type === "tool_result",
      );
    if (hasToolResult) {
      writeSse(response, textFrames("Claude used echo"));
      return;
    }
    const prompt = typeof last?.content === "string" ? last.content : "";
    if (prompt.includes("echo")) {
      writeSse(response, echoToolFrames());
      return;
    }
    writeSse(response, textFrames(`Claude reply: ${prompt || "hello"}`));
  });
  return new Promise((resolve) => {
    fixture.listen(0, "127.0.0.1", () => {
      const address = fixture.address();
      fixturePort = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
}

async function launchBorg(): Promise<void> {
  application = await electron.launch({
    executablePath: electronPath,
    args: [desktopApp, `--user-data-dir=${profileDirectory}`],
    env: launchEnvironment,
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function connectAnthropic(): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.anthropic.settings").click();
  await expect(page.getByTestId("anthropic-setup-step")).toBeVisible();
  await page.getByTestId("anthropic-api-key").fill("sk-ant-e2e");
  await page.getByTestId("anthropic-save-key").click();
  await expect(page.getByTestId("anthropic-api-key")).toHaveValue("");
  await expect(page.getByTestId("anthropic-status")).not.toContainText(
    "Claude is connected",
  );
  await page.getByTestId("anthropic-connect").click();
  await expect(page.getByTestId("anthropic-status")).toContainText("connected");
}

async function pickSonnet(): Promise<void> {
  await page.getByTestId("settings-section-borg.chat.personas").click();
  await page.getByTestId("wizard-model-select").selectOption({
    label: "Claude Sonnet 5",
  });
  await expect(page.getByTestId("wizard-model-select")).toHaveValue(
    "borg.anthropic:claude-sonnet-5",
  );
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-7-"));
  await startFixture();
  launchEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  launchEnvironment.BORG_E2E = "1";
  launchEnvironment.BORG_ANTHROPIC_ENDPOINT = `http://127.0.0.1:${fixturePort}/v1/messages`;
  launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  await launchBorg();
  await completeSetup(page);
});

test.afterEach(async () => {
  const currentApplication = application;
  if (currentApplication) {
    const process = currentApplication.process();
    if (process.exitCode === null) {
      const exit = waitForExit(process);
      process.kill();
      await exit;
    }
  }
  await new Promise<void>((resolve, reject) => {
    fixture.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(profileDirectory, { recursive: true, force: true });
});

test("connects Anthropic through settings and streams a billed chat turn", async () => {
  await connectAnthropic();
  await pickSonnet();

  await page.getByTestId("nav-chat").click();
  await page.getByTestId("chat-new-session").click();
  await page.getByTestId("chat-composer-input").fill("hello slice 7");
  await page.getByTestId("chat-send").click();
  await expect(
    page.getByTestId("chat-message").filter({ hasText: "Claude reply" }),
  ).toBeVisible();
  await expect(page.getByTestId("chat-session-usage")).toContainText("USD");

  await page.getByTestId("nav-activity").click();
  await expect(page.getByTestId("flightdeck-session-usage")).toBeVisible();
  await expect(page.getByTestId("usage-input-tokens")).not.toHaveText("0");
  await expect(page.getByTestId("usage-cost")).toContainText("USD");

  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.anthropic.settings").click();
  await page.getByTestId("anthropic-api-key").fill("sk-ant-replaced");
  await page.getByTestId("anthropic-save-key").click();
  await expect(page.getByTestId("anthropic-api-key")).toHaveValue("");
  await expect(page.getByTestId("anthropic-status")).toContainText("Verify");
  await expect(page.getByTestId("anthropic-status")).not.toContainText(
    "Claude is connected",
  );

  await page.getByTestId("anthropic-delete-key").click();
  await expect(page.getByTestId("anthropic-status")).toContainText("removed");
  await expect(page.getByTestId("anthropic-connect")).toBeDisabled();
});

test("runs an Anthropic tool call through tools.echo and a matching tool_result", async () => {
  await connectAnthropic();
  await pickSonnet();

  await page.getByTestId("nav-chat").click();
  await page.getByTestId("chat-new-session").click();
  await page.getByTestId("chat-composer-input").fill("echo hello slice 7");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("interaction-overlay")).toBeVisible();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "tools.echo",
  );
  await page.getByTestId("interaction-allow").click();
  await expect(
    page.getByTestId("chat-message").filter({ hasText: "Claude used echo" }),
  ).toBeVisible();

  expect(capturedPosts.length).toBeGreaterThanOrEqual(2);
  const first = capturedPosts[0] as {
    readonly tools?: readonly { readonly name?: string }[];
  };
  expect(first.tools?.some((tool) => tool.name === "tools_echo")).toBe(true);
  const second = capturedPosts[1] as {
    readonly messages?: readonly { readonly content?: unknown }[];
  };
  const toolResults = (second.messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter(
          (block): block is { type: string; tool_use_id?: string } =>
            Boolean(block) &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "tool_result",
        )
      : [],
  );
  expect(toolResults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "tool_result",
        tool_use_id: ECHO_TOOL_USE_ID,
      }),
    ]),
  );
});
