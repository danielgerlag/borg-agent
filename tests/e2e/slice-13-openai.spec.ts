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
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
      },
    })}`,
    "data: [DONE]",
  ];
}

function echoToolFrames(): string[] {
  return [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: ECHO_TOOL_USE_ID,
                type: "function",
                function: { name: "tools_echo", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"text":"hello slice 13"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}`,
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 6, completion_tokens: 3 },
    })}`,
    "data: [DONE]",
  ];
}

function startFixture(): Promise<void> {
  capturedPosts = [];
  fixture = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    if (authorization !== "Bearer sk-openai-e2e") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models/gpt-5-mini") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "gpt-5-mini" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as {
      readonly messages?: readonly {
        readonly role?: string;
        readonly content?: unknown;
      }[];
      readonly tools?: readonly {
        readonly type?: string;
        readonly function?: { readonly name?: string };
      }[];
    };
    capturedPosts.push(body);
    const last = body.messages?.at(-1);
    if (last?.role === "tool") {
      writeSse(response, textFrames("GPT used echo"));
      return;
    }
    const prompt = typeof last?.content === "string" ? last.content : "";
    if (prompt.includes("echo")) {
      writeSse(response, echoToolFrames());
      return;
    }
    writeSse(response, textFrames(`GPT reply: ${prompt || "hello"}`));
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

async function connectOpenAI(): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.openai.settings").click();
  await expect(page.getByTestId("openai-setup-step")).toBeVisible();
  await page.getByTestId("openai-api-key").fill("sk-openai-e2e");
  await page.getByTestId("openai-save-key").click();
  await expect(page.getByTestId("openai-api-key")).toHaveValue("");
  await expect(page.getByTestId("openai-status")).not.toContainText(
    "GPT is connected",
  );
  await page.getByTestId("openai-connect").click();
  await expect(page.getByTestId("openai-status")).toContainText("connected");
}

async function pickGpt5Mini(): Promise<void> {
  await page.getByTestId("settings-section-borg.chat.personas").click();
  await page.getByTestId("wizard-model-select").selectOption({
    label: "GPT-5 Mini",
  });
  await expect(page.getByTestId("wizard-model-select")).toHaveValue(
    "borg.openai:gpt-5-mini",
  );
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-13-"));
  await startFixture();
  launchEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  launchEnvironment.BORG_E2E = "1";
  launchEnvironment.BORG_OPENAI_ENDPOINT = `http://127.0.0.1:${fixturePort}/v1/chat/completions`;
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

test("connects OpenAI through settings and streams a billed chat turn", async () => {
  await connectOpenAI();
  await pickGpt5Mini();

  await page.getByTestId("nav-chat").click();
  await page.getByTestId("chat-new-session").click();
  await page.getByTestId("chat-composer-input").fill("hello slice 13");
  await page.getByTestId("chat-send").click();
  await expect(
    page.getByTestId("chat-message").filter({ hasText: "GPT reply" }),
  ).toBeVisible();
  await expect(page.getByTestId("chat-session-usage")).toContainText("USD");

  await page.getByTestId("nav-activity").click();
  await expect(page.getByTestId("flightdeck-session-usage")).toBeVisible();
  await expect(page.getByTestId("usage-input-tokens")).not.toHaveText("0");
  await expect(page.getByTestId("usage-cost")).toContainText("USD");

  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.openai.settings").click();
  await page.getByTestId("openai-api-key").fill("sk-openai-replaced");
  await page.getByTestId("openai-save-key").click();
  await expect(page.getByTestId("openai-api-key")).toHaveValue("");
  await expect(page.getByTestId("openai-status")).toContainText("Verify");
  await expect(page.getByTestId("openai-status")).not.toContainText(
    "GPT is connected",
  );

  await page.getByTestId("openai-delete-key").click();
  await expect(page.getByTestId("openai-status")).toContainText("removed");
  await expect(page.getByTestId("openai-connect")).toBeDisabled();
});

test("runs an OpenAI tool call through tools.echo and a matching tool role", async () => {
  await connectOpenAI();
  await pickGpt5Mini();

  await page.getByTestId("nav-chat").click();
  await page.getByTestId("chat-new-session").click();
  await page.getByTestId("chat-composer-input").fill("echo hello slice 13");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("interaction-overlay")).toBeVisible();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "tools.echo",
  );
  await page.getByTestId("interaction-allow").click();
  await expect(
    page.getByTestId("chat-message").filter({ hasText: "GPT used echo" }),
  ).toBeVisible();

  expect(capturedPosts.length).toBeGreaterThanOrEqual(2);
  const first = capturedPosts[0] as {
    readonly tools?: readonly {
      readonly type?: string;
      readonly function?: { readonly name?: string };
    }[];
  };
  expect(
    first.tools?.some((tool) => tool.function?.name === "tools_echo"),
  ).toBe(true);
  const second = capturedPosts[1] as {
    readonly messages?: readonly {
      readonly role?: string;
      readonly tool_call_id?: string;
    }[];
  };
  expect(second.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: ECHO_TOOL_USE_ID,
      }),
    ]),
  );
});
