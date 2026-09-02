# Borg — Init Spec

This is the brief for a coding agent building Borg. Product behavior is inspired by HiveMind OS. Architecture is not: Borg is a TypeScript microkernel inside an Electron app, with almost all product features as in-process plugins.

Reference repo: https://github.com/hivemind-os/hivemind

Read HiveMind as a **behavior and UX source**. Do not copy its daemon/client split, crate layout, or “chat/workflows/bots live in core” ownership. Copy screens, session semantics, persona model, approval gates, classification rules, workflow (graph) engine ideas, connector patterns, and the plugin SDK *shape* — then recut ownership as specified here.

---

## 1. Mission

Build **Borg**, a privacy-first local desktop agent platform.

A user runs Borg on their machine, talks to personas in chat, runs graph automations, leaves background bots working, and connects mail/chat/search/MCP tools — without a hosted control plane.

HiveMind does this with a Rust daemon + Tauri/SolidJS client, and a thin connector plugin layer. Borg does it with:

- **Electron main process = the kernel** (always-on while the app is “running”)
- **Renderer = UI shell** (extension points only; no business logic)
- **Plugins = product** (chat, graphs, bots, models, tools, connectors, memory implementations, …)
- **One TypeScript plugin SDK** that every plugin is built on

If the kernel grows a chat implementation, a graph executor, an MCP client, or an OpenAI HTTP client, the architecture has failed.

---

## 2. Locked decisions

Do not re-litigate these. If a later idea conflicts, stop and ask.

| Decision | Rule |
|---|---|
| Process model | Electron **main is the kernel**. Renderer is a client of the kernel over a kernel-owned IPC bridge. |
| Lifetime | Closing the window **hides to tray**. It does not stop loops, graphs, bots, or connectors. **Quit** (tray menu or explicit quit) stops the kernel. |
| Tray | Always-on tray icon. Show/hide window, pending-approval indicator, running loop/bot/graph counts, Quit. |
| Personas | **Kernel-owned**, same concept as HiveMind (identity, instructions, models, allowed tools, MCP config, loop strategy). Chat, bots, and graphs all consume personas from the kernel. |
| Plugins | **In-process**. Not HiveMind-style Node child processes over JSON-RPC. Bundled and third-party plugins use the same loader. |
| Graphs | HiveMind **workflows**, renamed **graphs**. The graph engine **must not** use LangGraph. Take deep inspiration from `hive-workflow` / `hive-workflow-service` and the HiveMind designer. |
| LangGraph | **Allowed** in the kernel agentic-loop runtime (ReAct, CodeAct, tool calling, structured output) if it is a net win. **Forbidden** as the graph/workflow engine. Do not make LangGraph a dependency of the graphs plugin. If LangGraph fights Electron main or the plugin boundary, write a thin loop instead — do not force it. |
| UI stack | Match HiveMind desktop so UX can be copied: **SolidJS + Vite + Tailwind + Kobalte + lucide-solid + CodeMirror + Cytoscape**. Electron instead of Tauri. Playwright for UI e2e. |
| Language | TypeScript throughout. No Rust daemon. No separate client/server tier. |
| Inter-plugin | No plugin may import another plugin’s package. Kernel **contributions + typed commands/events** only. Host APIs are for kernel services; the bus is not a dumping ground. |
| Bus | One command/event bus in **main**. Commands: one handler, Zod in/out, request/response. Events: 0–N subscribers, Zod payload, no return. Schemas live in `@borg/contracts`, not inside a plugin implementation. Duplicate command ids fail load. |
| Human feedback | Tool approvals and classification violations are kernel protocol + kernel default UI. The **ask-user tool** and **feedback gates** (graphs, loops, bots) are bundled plugin `borg.feedback`. Pending interactions live in the kernel queue so they survive window hide. |
| Security enforcement | Classification, permission, and approval **enforcement** stay in the kernel on every tool call and outbound channel. Scanners (prompt injection) may be plugins; they cannot be the only gate. |
| Persistence | Kernel owns **facades**. Backends (sqlite config, OS keychain, dev secret store) are plugins. Callers never select a backend. |
| Honesty | Bundled plugins load through the same SDK/loader as a third-party plugin would. “Plugin” that is actually a kernel module is a bug. |

---

## 3. How the coding agent must work

1. **Research first.** Clone or fetch HiveMind read-only. Write `docs/research/hivemind.md` answering the research questions in §16. No product implementation in this step.
2. **Architecture second.** Write `docs/architecture.md` covering kernel modules, contribution types, IPC, plugin lifecycle, command/event catalog, and slice-0 repo layout. Stop if a locked decision is insufficient.
3. **Implement slices in order.** Each slice in §15 is a vertical slice: user-visible behavior + tests. Do not start slice N+1 until slice N’s acceptance tests pass.
4. **Copy HiveMind with a mapping table**, not by forking crates into `src/`. Use §10.
5. **Stop and ask** on the list in §17. Do not invent a second event bus, a second loop engine, or a daemon.

Quality bar: every slice is extensively verified (contract + unit + UI e2e where the slice has UI). UI must stay in HiveMind’s visual language — one token set, kernel UI kit, no new CSS framework. Add `data-testid` on any control an e2e test needs.

---

## 4. Non-goals (v1)

- Hosted backend, multi-user, accounts, cloud sync
- Plugin marketplace
- HiveMind daemon, Tauri, or Rust port
- Using LangGraph (or any graph-lib) as the graphs engine
- A second agentic-loop implementation once one loop runtime exists (HiveMind’s `hive-loop::legacy` vs `hive-workflow` split is a bug to not copy)
- Crash-isolated plugin processes (in-proc is the v1 trade: wrap handlers, isolate failures, accept that a native crash can take the app down)
- Mobile
- Rewriting LangGraph
- Pixel-perfect clone of every HiveMind screen on day one — copy structure and interaction, then tighten

---

## 5. Product in ten minutes

1. Install/run Borg. Tray icon appears. Setup wizard runs (kernel wizard slots + plugin steps).
2. User configures a model (or keeps the mock provider in dev) and a default persona.
3. Main window: workspace (chat by default), settings, flight deck.
4. User sends a message. Loop runs, tools may request approval, tokens/cost are recorded.
5. User can hide the window; the tray stays; a running graph or bot continues.
6. Quit from the tray stops everything.

---

## 6. Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron, `contextIsolation: true`, sandboxed renderer, preload as the only IPC bridge |
| Kernel | Electron main, TypeScript strict |
| UI | SolidJS, Vite, Tailwind, Kobalte, lucide-solid, CodeMirror, Cytoscape, class-variance-authority / tailwind-merge (same family as HiveMind desktop) |
| Plugin SDK | TypeScript package `@borg/plugin-sdk` |
| Agentic loops | Kernel strategy API (`ReAct`, `CodeAct`, …). LangGraph JS **may** implement these. |
| Graphs | Custom engine in the graphs plugin, inspired by HiveMind `hive-workflow`. **No LangGraph.** |
| Tests | Vitest (unit/contract), Playwright against the Electron app (UI e2e) |
| Package manager | pnpm workspaces |
| Schema | Zod in the SDK (HiveMind plugin config pattern: schema → settings UI) |

HiveMind frontend reference: `apps/hivemind-desktop/package.json` (SolidJS 1.9, Tailwind 3, Kobalte, CodeMirror 6, Cytoscape, Playwright, Vitest).

---

## 7. Process model

```text
┌─────────────────────────────────────────────────────────────┐
│  Electron app (one OS process for v1, in-proc plugins)      │
│                                                             │
│  Main = KERNEL                                              │
│    plugin loader / lifecycle / permissions                  │
│    contribution registry                                    │
│    command + event bus                                      │
│    personas                                                 │
│    loop runtime (LangGraph OK here)                         │
│    tool pipeline (perm → classify → approve → sandbox)      │
│    persistence / secrets / config facades                   │
│    tray, notifications, cost ledger, prompt assembler       │
│    plugin service modules (in-proc)                         │
│                                                             │
│  Preload = typed IPC (no plugin-authored channels)          │
│                                                             │
│  Renderer = SHELL                                           │
│    workspace / settings / wizard / flight-deck slots        │
│    themes, toasts, default approval UI                      │
│    plugin UI contributions (SolidJS), in-proc in renderer   │
└─────────────────────────────────────────────────────────────┘
         ▲
         │  hide window ≠ quit
         ▼
   Tray icon (main)
```

Implications:

- Kernel state outlives the window. Session workers, graph runs, bot loops, connector polling, and schedulers live in **main**.
- Plugin packages typically have two entry points: `main` (kernel-side) and `ui` (renderer-side). Both are in-process. They talk only through kernel host APIs / the bus, never `ipcRenderer` ad hoc.
- In-proc is not “no isolation”: the loader wraps plugin handlers, times out where needed, and disables a plugin that throws on activate without taking down the kernel. Do not pretend this is a sandbox. Tool **subprocess** sandboxes (OS, uv, Node) are separate and kernel-owned.

---

## 8. Architecture: three buckets

### 8.1 Kernel — contracts, trust, shell, personas

Kernel owns process, trust, and contracts. It does **not** own product features.

**Must live in kernel:**

1. Plugin load, activate, deactivate, enable/disable; manifest permission checks; host/plugin version compatibility
2. Capability registry and extension points, including **plugin-defined** extension points (so graphs can have child step-type plugins)
3. Typed command + event bus (the only inter-plugin wiring)
4. Persistence, config, and secrets **facades** (routing to backend plugins)
5. Agentic loop **runtime APIs** and loop lifecycle (ReAct, CodeAct, …). Management: start, pause, cancel, list, subscribe to events
6. Tool invocation **pipeline**: session/persona permission → data classification → approval protocol → sandbox → execute → cost/audit
7. Sandbox **factory** for tools and agents: OS-level, uv, Node.js (the sandboxes, not the tools that use them)
8. Data-classification **plumbing and enforcement** (labels, channel-class vs data-class, outbound rules)
9. Approval **protocol** + default UI for **tool approvals and classification violations only** (safety; must work if `borg.feedback` is disabled)
10. Human-interaction **queue**: create / list / respond / subscribe; tray pending count; persistence across window hide. Does **not** own ask-user copy or gate UX.
11. Communication **core services** for channel plugins (inbound/outbound message model, routing into loops/graphs/bots, dedup, attachments)
12. A2A **plumbing** (host an agent over an A2A protocol; protocol named in architecture.md after research — default target: Google Agent2Agent)
13. Core services needed by **graph-engine** plugins (run store hooks, event topics, workspace allocation, interaction-queue hook used by `feedback_gate`)
14. Core services needed by **scheduling** plugins (timer/cron backbone, run history hooks)
15. Personas (HiveMind concept: YAML-ish identity, instructions, preferred models, allowed tools, MCP server list, loop strategy, skills)
16. System-prompt **assembly** from registered prompt slots (persona + memory + context-map + skills + plugin injections)
17. Memory **abstractions** (graph + semantic): interfaces, not the HiveMind SQLite knowledge implementation
18. Cost/token accounting APIs (plugins emit; kernel stores and exposes)
19. Central agent and tool permission model
20. Notification API (OS notifications + in-app toasts)
21. UI shell: tray, window chrome, themes, extension points for **main workspace**, **settings**, **setup wizard**, **flight deck** (empty slots; widgets are plugins)
22. Default **tool-approval / classification** UI (plugins may contribute `interactionRenderer`s; kernel always has a fallback for those two kinds)

**Must not live in kernel:**

- Chat UI, session history, workspace folder browser, sub-agent UX
- Graph executor, graph designer, graph YAML/JSON schema beyond generic run hooks
- Bot manager UI or bot run loop
- Ask-user tool, feedback-gate prompts, or other human-question UX (`borg.feedback`)
- LLM HTTP clients (OpenAI, Anthropic, …) except nothing — even the mock provider is a plugin
- MCP client, MCP Apps iframe bridge implementation
- Connectors (M365, Google, IMAP, Discord, …)
- Web search providers
- Prompt-injection **scanner** implementation
- Knowledge-base / memory **provider** implementation
- Config/secret **backend** implementations (sqlite, OS keychain, dev store)
- Filesystem/shell/web tools
- Context-map **construction** implementation
- Flight-deck widgets

### 8.2 Bundled plugins — ship with the app, same loader

Each is a first-class plugin with its own setup/config UI where needed.

### 8.3 Third-party plugins — later, same SDK

Same contribution types, same in-proc loader, declared permissions. v1 may only ship bundled plugins but the loader must not special-case them beyond “packaged with the app” discovery.

---

## 9. Plugin model

### 9.1 SDK

Package: `@borg/plugin-sdk`.

Every plugin is built on it, plus `@borg/contracts` when it declares or invokes bus commands/events. HiveMind’s `@hivemind-os/plugin-sdk` is the starting *shape* (`definePlugin`, Zod `configSchema`, tools, background loop, `createTestHarness`) — then expand far beyond connector-only contributions.

Sketch (illustrative, not frozen API):

```ts
import { definePlugin, z } from '@borg/plugin-sdk';

export default definePlugin({
  id: 'borg.chat',
  version: '0.1.0',
  engines: { borg: '^1.0.0' },
  permissions: ['ui.workspace', 'loops.start', 'fs.sessionWorkspace'],
  configSchema: z.object({ /* optional */ }),
  contributes: {
    workspaceView: { id: 'chat', label: 'Chat', surface: 'main' },
    commands: [/* declare ids implemented via ctx.bus.handle */],
    events: [/* declare ids this plugin may emit */],
  },
  activate(ctx) { /* register handlers, tools, ui */ },
  deactivate(ctx) { /* cleanup */ },
});
```

Host context (kernel APIs available to plugins) must cover at least what HiveMind’s plugin `ctx` covers, plus Borg’s bus:

- `ctx.config`, `ctx.secrets`, `ctx.store` (facades)
- `ctx.personas`, `ctx.permissions`
- `ctx.loops` (start/cancel/subscribe)
- `ctx.tools` (register; execution still goes through the kernel pipeline)
- `ctx.bus.invoke` / `handle` / `emit` / `on` / `provides` (see §9.5)
- `ctx.interactions` (queue: request / listPending / respond / subscribe)
- `ctx.ui` (workspace, settings, wizard, flight deck, toasts)
- `ctx.notify`, `ctx.logger`, `ctx.http`, `ctx.dataDir`
- `ctx.cost.record`, `ctx.memory` (abstractions), `ctx.prompts.registerSlot`
- `ctx.sandbox`, `ctx.classify`
- `ctx.host.version` / `platform`

### 9.2 Contribution types (minimum)

Kernel defines these. Plugins register them. Plugins may also **define new extension points** (graphs plugin defines `graphStep` and `graphTrigger`).

| Contribution | Purpose |
|---|---|
| `llmProvider` | Model implementation: auth, setup UI, tool-calling convention, token caching |
| `tool` / `toolProvider` | Agentic tools |
| `workspaceView` | Main workspace tab/panel (chat is one) |
| `settingsPage` | Settings window section |
| `wizardStep` | Setup wizard step |
| `flightDeckWidget` | Live flight-deck widget |
| `theme` | UI theme |
| `interactionRenderer` | UI for a pending interaction `kind` (`tool_approval`, `classification`, `human_input`). Kernel fallback for the first two. |
| `graphEngine` | A graphs runtime (bundled: one HiveMind-inspired engine) |
| `graphStep` / `graphTrigger` | Child contributions onto the graphs plugin |
| `botRuntime` | Background bot feature |
| `channel` | Communication connector (mail, DM, group, …) |
| `searchProvider` | Web search |
| `memoryProvider` | Graph + semantic memory backend |
| `secretStore` / `configStore` | Persistence backends |
| `promptSlot` | Inject into system prompt assembly |
| `promptScanner` | Prompt-injection / risk scan |
| `scheduler` | Scheduling implementation using kernel timer services |
| `mcpClient` | MCP client + catalog |
| `mcpApp` | MCP Apps surface inside a session |
| `a2aEndpoint` | Expose an agent over A2A |
| `command` / `event` | Typed bus contracts |

### 9.3 Permissions (declared, even though in-proc)

Manifest permissions are enforced at the host API. Examples: `network:<host>`, `fs:sessionWorkspace`, `secrets:read`, `ui.workspace`, `loops.start`, `subprocess:uv`, `channels.send`. A plugin calling an API it did not declare is a hard error.

### 9.4 Versioning

- Kernel host API: semver (`borg` engine version).
- Plugin declares `engines.borg`.
- Contribution payloads are versioned schemas (Zod).
- Incompatible plugin: do not activate; surface in UI; do not crash the app.
- Deprecation window: host may support n-1 contribution schemas.
- Bundled plugins may use workspace protocol (`workspace:*`) but still declare `engines.borg`.

### 9.5 Bus contract

The kernel has **four** extension mechanisms. Do not collapse them into one EventEmitter.

| Mechanism | Shape | Use |
|---|---|---|
| **Host API** (`ctx.personas`, `ctx.loops`, `ctx.secrets`, `ctx.interactions`, …) | Typed methods the kernel implements | Kernel-owned services |
| **Contributions** | Declarative registration | “I *am* a workspace view / LLM provider / graph step” |
| **Commands** | Request/response, Zod in/out, **exactly one handler** | “Do this, give me a result” |
| **Events** | Fire-and-forget, Zod payload, **0–N subscribers** | “This happened” |

The bus is **commands + events only**. Tool execution, LLM calls, secrets, config, classification enforcement, and token streams are **not** bus messages.

**Forbidden:** `import from '@borg/plugin-graphs'` (or any other plugin package) inside another plugin.

**Required:** plugins depend on `@borg/plugin-sdk` and `@borg/contracts`. Contracts hold `defineCommand` / `defineEvent` + Zod schemas. They contain **no implementation**. Chat may import `graphsLaunch` from contracts; it may not import the graphs plugin.

There is **one bus, in main**. Renderer `invoke`/`on` is IPC onto that bus. Same-plugin main ↔ UI uses the bus too (no ad hoc `ipcRenderer`). Do not create a second bus in the renderer.

#### Commands

```ts
import { defineCommand } from '@borg/contracts';
import { z } from 'zod';

export const graphsLaunch = defineCommand({
  id: 'borg.graphs.launch',
  input: z.object({
    graphId: z.string(),
    sessionId: z.string().optional(),
    input: z.record(z.unknown()).optional(),
  }),
  output: z.object({ instanceId: z.string() }),
});

// provider (graphs plugin)
ctx.bus.handle(graphsLaunch, async (input) => { /* start run */ return { instanceId }; });

// consumer (chat plugin) — no import of the graphs plugin
const { instanceId } = await ctx.bus.invoke(graphsLaunch, { graphId, sessionId });
```

Rules:

1. **Exactly one handler.** Two plugins registering the same command id is a **load failure**, not last-write-wins. Fan-in (two graph engines) is a `graphEngine` contribution plus a picker, not two handlers on one id.
2. **Zero handlers** → error `{ code: 'unavailable' }`. UI uses `ctx.bus.provides(graphsLaunch)` to hide “Run graph”. This is not an unhandled exception.
3. Kernel **parses input and output** with the registered Zod schemas.
4. Default **timeout** + `AbortSignal`. Long-running work returns an id immediately; progress is events (`borg.graphs.instance.completed`).
5. A plugin **handles only commands it declared**. It **emits only events it declared**. v1: any loaded plugin may **invoke** any public command. Tightening invoke ACLs is later.
6. Queries are commands that do not mutate (`borg.graphs.listRunning`). No separate CQRS layer in v1.
7. Closed error union: `unavailable` | `invalid_input` | `invalid_output` | `forbidden` | `timeout` | `failed`.
8. Every invoke/emit gets a **correlation id** (tests and flight deck).

#### Events

```ts
export const inboundMessage = defineEvent({
  id: 'borg.channel.inboundMessage',
  payload: z.object({
    channelId: z.string(),
    messageId: z.string(),
    sender: z.object({ id: z.string(), name: z.string().optional() }),
    text: z.string(),
    classification: z.string().optional(),
  }),
});

ctx.bus.emit(inboundMessage, payload);
ctx.bus.on(inboundMessage, async (payload) => { /* graphs trigger / bot / chat */ });
```

Rules:

- Many subscribers. The emitter does not name them.
- Async dispatch. Subscriber failures are isolated (`allSettled`); they do not fail the emitter.
- **No sticky events, no replay in v1.** Current state is a command (`listRunning`). Events are deltas.
- Exact id match. No topic wildcards in v1.

#### Command vs event vs kernel (decision table)

| Need | Mechanism |
|---|---|
| Chat launches a graph, needs `instanceId` | command `borg.graphs.launch` |
| IMAP/Discord message arrives; several plugins may care | event `borg.channel.inboundMessage` |
| Agent or graph needs a human answer (window may be hidden) | command `borg.feedback.ask` → kernel interaction queue → `borg.feedback` UI |
| Tool/classification allow/deny | kernel tool pipeline + `ctx.interactions` kind `tool_approval` / `classification` |
| Token stream / step traces | events from the owner, or kernel loop subscribe — **not** a blocking command |
| Cost, secrets, personas, start loop | host APIs, not the bus |

#### v0 catalog (ids stable; fields may thicken in architecture.md)

| Id | Kind | Declared by | Used by |
|---|---|---|---|
| `borg.hello.getStatus` | command | `borg.hello` | hello UI (slice 1 proves the bus) |
| `borg.graphs.launch` | command | `borg.graphs` | chat, tools, other plugins |
| `borg.graphs.listRunning` | command | `borg.graphs` | flight-deck widgets, chat |
| `borg.graphs.instance.started` / `.completed` / `.failed` | events | `borg.graphs` | shell, chat, bots |
| `borg.graphs.step.completed` | event | `borg.graphs` | flight deck |
| `borg.chat.append` | command | `borg.chat` | graphs, bots, feedback (inject a line into a session) |
| `borg.chat.turn.completed` | event | `borg.chat` | flight deck, graphs |
| `borg.channel.inboundMessage` | event | each `channel` plugin | graphs triggers, bots, chat |
| `borg.feedback.ask` | command | `borg.feedback` | loops (via ask-user **tool**), graphs `feedback_gate`, any plugin |
| `borg.feedback.requested` | event | `borg.feedback` | chat (transcript hint), tray/flight deck |
| `borg.feedback.resolved` | event | `borg.feedback` | waiters, chat |
| MCP Apps register/invoke/respond | commands | `borg.mcp-apps` + `borg.chat` | slice 8; define in architecture.md from HiveMind’s app-tool bridge |

Adding a catalog entry is a contracts-package change, not a kernel change, unless a new **contribution type** is required.

### 9.6 Human feedback plugin (`borg.feedback`)

Agents (chat turns, graph `feedback_gate`, bots) need to **ask a human** and wait. That is not chat, and it is not a tool-approval. HiveMind splits `Question` / `UserInteractionGate` from `workflow_gate`; Borg implements **one** human-input path as a bundled plugin, on top of the kernel queue.

**Kernel** (`ctx.interactions`):

- Kinds: `tool_approval` | `classification` | `human_input`
- `request({ kind, title, prompt, form, choices, source, correlationId })` → waits until `respond` or abort
- Pending list survives window hide; tray badge is the pending count
- Routes UI to an `interactionRenderer` matching `kind`; **fallback UI only for `tool_approval` and `classification`**

**Plugin `borg.feedback`:**

- Registers tool `feedback.ask` (HiveMind-style “ask the user”). Forms: `text` | `confirm` | `choice`. **Approval default: auto** — the question *is* the human gate; do not double-prompt with a tool-approval modal.
- Handles command `borg.feedback.ask` (same payload as the tool). Graphs `feedback_gate` **invokes this command**, it does not import chat and does not call `borg.chat.append` to wait for an answer.
- Contributes `interactionRenderer` for `human_input` (modal + pending list) and a flight-deck widget for outstanding questions.
- Emits `borg.feedback.requested` / `borg.feedback.resolved`. Chat may listen and add a transcript line via `borg.chat.append`; chat does not own the prompt UI.
- Settings: timeout defaults, whether to steal focus / OS notify on ask.

**If `borg.feedback` is disabled:** `feedback.ask` tool is absent; `borg.feedback.ask` returns `unavailable`; graph `feedback_gate` fails with that error; **tool approvals still work**.

**Call path (ask-user tool):**

```text
loop/graph/bot → tool `feedback.ask`
  → kernel tool pipeline (perm, classify; approval=auto)
  → plugin handler
  → ctx.interactions.request({ kind: 'human_input', ... })
  → queue + tray + renderer
  → human answers (window visible or after show-from-tray)
  → respond → tool result → loop continues
```

**Call path (graph `feedback_gate`):**

```text
graphs executor hits feedback_gate
  → ctx.bus.invoke(feedbackAsk, { prompt, form, instanceId, stepId })
  → same queue / UI as the tool
  → output { answer } → step completes
```

Do not add a second “ask chat” path. Headless bots and hidden-window graphs must use this plugin + kernel queue.

---

## 10. HiveMind mapping

Use this when copying. “Copy” means behavior, data model, and UX. “Do not copy” means ownership and process topology.

| HiveMind | Copy | Do not copy | Borg owner |
|---|---|---|---|
| `hive-daemon` + `hive-api` as composition root | Service wiring discipline | Separate daemon process, Axum, Tauri `authFetch` | Electron main kernel |
| `hive-chat` sessions, workspace dir, events, sub-agents | Session semantics, workspace, event stream, UX | Chat as core crate | **Chat plugin** |
| `hive-loop::legacy` ReAct / CodeAct / tool execution | Strategies, approval gate in the tool path | Two unrelated loop systems | **Kernel loop runtime** (LangGraph OK) |
| `hive-workflow` + designer | Schema, steps, triggers, persistence, designer UX | LangGraph; YAML-only if JSON is a better Electron fit — decide in architecture.md | **Graphs plugin** (+ child step plugins) |
| Bots | Background agent + UI + tools to manage bots | Daemon-owned bot runtime | **Bots plugin** |
| Personas | ID scheme, YAML fields, allowed tools, MCP list, loop strategy | Persona living only in chat | **Kernel** |
| `hive-model` providers | Per-provider setup UI, tool-calling, caching, auth | Providers in core | **One LLM plugin per provider** + mock |
| `hive-tools` filesystem/shell | Tool IDs, workspace scoping, approval defaults | Built-in tools in kernel | **Core-tools plugin** |
| `hive-mcp` + MCP Apps | Transports, catalog, session tools, iframe app tools | MCP in core | **MCP plugin**; Apps need chat cooperation via bus |
| `hive-connectors` | Message emit, classification, config UI, background loop | Rust connectors in core | **One plugin per connector** |
| `hive-web-search` | Tavily / Brave as separate providers | Search in core | **One plugin per provider** |
| `hive-risk` prompt injection | Scan-before-turn, review/block | Enforcement inside the scanner | **Scanner plugin** + **kernel enforcement** |
| `hive-knowledge` + sqlite-vec | Graph + vectors memory | Concrete DB as kernel | **Memory interface in kernel**, HiveMind-like store as **plugin** |
| `hive-context-map` | Workspace summaries into the prompt | Implementation in chat core | **Context-map plugin** + kernel prompt slots |
| `hive-classification` | Data classes, channel rules | Optional/off by default | **Kernel plumbing** |
| `hive-plugins` JSON-RPC child processes | `definePlugin`, Zod config, host ctx, test harness | Out-of-proc Node host | **In-proc loader + expanded SDK** |
| `hive-sandbox` / node-env / python-env | OS, Node, uv/python sandboxes | Sandboxes only for plugins, not tools | **Kernel sandbox factory** |
| Flight deck | Mission-control UX | Hard-coded widgets | **Kernel slots + plugin widgets** |
| Desktop SolidJS app | Visual language, Playwright, `data-testid` | Tauri, `activeScreen` mega-`App.tsx` as the only state | **Renderer shell + stores** |
| Secrets / config | OS keyring + config yaml/sqlite + plugin store | Backends in kernel | **Facade in kernel, backends as plugins** |
| `UserInteractionGate` / `Question` / `workflow_gate` | Human wait, pending while AFK, question + choice forms | Chat-owned questions; two gate systems | **Kernel queue** + **`borg.feedback`** (one path for ask-user tool and graph gates). Tool/class approvals stay kernel. |

HiveMind paths to read (minimum):

- `ARCHITECTURE.md`, `CLAUDE.md`, `TESTING_GUIDE.md`
- `packages/plugin-sdk/README.md` and types
- `crates/hive-plugins/` (protocol — contrast only)
- `crates/hive-chat/src/chat.rs`, `crates/hive-loop/src/legacy/`
- `crates/hive-workflow/`, `crates/hive-workflow-service/`
- `crates/hive-contracts/` (personas, tools, **interactions**, MCP)
- `crates/hive-classification/`, `crates/hive-risk/`
- `crates/hive-knowledge/`, `crates/hive-context-map/`
- `apps/hivemind-desktop/src/` (shell, flight deck, workflow designer, approvals, personas, wizard)

---

## 11. Bundled plugins (v1 catalog)

Implement as real plugins. Config UIs ship with the plugin that owns the config.

| Plugin | Role | HiveMind source |
|---|---|---|
| `borg.mock-llm` | Scripted LLM for e2e; transcript fixtures (“call tool X, then say Y”) | `hive-test-utils` mock providers |
| `borg.openai`, `borg.anthropic`, … | Real model providers; each has own setup UI, tool-calling, caching, auth | `hive-model` |
| `borg.chat` | Chat sessions: UI, history, local workspace folder browser, sub-agent management. **Not kernel.** | `hive-chat` + desktop chat UI |
| `borg.feedback` | Ask-user **tool**, `human_input` UI, command `borg.feedback.ask` for graph `feedback_gate` and any plugin. Flight-deck pending-questions widget. | HiveMind `Question` + `workflow_gate` (unified) |
| `borg.graphs` | Graph engine + designer UI + agent tools to manage graphs + launch from chat via bus. Child plugins for extra step types. **No LangGraph.** `feedback_gate` calls `borg.feedback.ask`, not chat. | `hive-workflow*` + `WorkflowDesigner.tsx` |
| `borg.bots` | Background bots feature, all UI, background services, agent tools to manage bots | HiveMind bots |
| `borg.mcp` | Internal MCP client, config UI, session tools | `hive-mcp` |
| `borg.mcp-apps` | MCP Apps inside a chat session (cooperate with `borg.chat` via bus; do not import chat) | HiveMind MCP Apps |
| `borg.tools.core` | Filesystem and other session-workspace tools | `hive-tools` filesystem/* |
| `borg.memory.knowledge` | Knowledge-base memory provider (graph + semantic) | `hive-knowledge` |
| `borg.context-map` | Context map construction | `hive-context-map` |
| `borg.security.prompt-injection` | Scanner around HiveMind risk concept | `hive-risk` |
| `borg.config.sqlite` | Bundled config persistence | HiveMind config/db |
| `borg.secrets.os` | OS secret stores | HiveMind keyring |
| `borg.secrets.dev` | Dev store for the local loop | — |
| `borg.search.tavily`, `borg.search.brave` | Web search, one plugin per provider | `hive-web-search` |
| `borg.channel.<name>` | One plugin per connector: M365, Google, IMAP, Discord, … | `hive-connectors` + sample plugins |
| Flight-deck widgets | Live widgets from chat/graphs/bots/cost/connectors | HiveMind flight deck |

Scheduler: kernel provides timer/cron **services**; a scheduling plugin may own UX and job types. Do not put cron UX in the kernel.

---

## 12. Testing bar

Testing is how a coding agent is allowed to keep going. A slice without its tests is not done.

**Mocking**

- LLM: only through `borg.mock-llm` (scripted transcripts, deterministic tool-call sequences). Never hit a real model in CI.
- External APIs (connectors, search, provider HTTP): mock at the plugin boundary, not by stubbing kernel internals.
- MCP: a mock MCP server fixture (HiveMind has `tools/mock-mcp-server`).

**Layers**

1. **SDK / bus contract tests** — load plugin, contribute, call host APIs, permission denial, engine version mismatch, deactivate; command `unavailable`, duplicate command id, Zod reject, event subscriber isolation.
2. **Loop tests** — mock LLM transcripts through the kernel pipeline (tools, approval, classification, cost, `feedback.ask`).
3. **Plugin harness tests** — HiveMind-style `createTestHarness` per plugin.
4. **Playwright e2e** — Electron app, real UI, `data-testid`. Small set of journeys, not a screenshot farm.

**UI**

- Reuse HiveMind’s visual language. No new component library.
- Kernel ships themes and tokens. Plugin UI must use the kernel UI kit.
- Every slice that touches UI includes at least one Playwright journey for the happy path and one for an error/empty/approval path.

---

## 13. Repo layout

```text
borg-agent/
  apps/desktop/              Electron main + preload + renderer shell
  packages/kernel/           Kernel libraries loaded by main (and types for preload)
  packages/plugin-sdk/       @borg/plugin-sdk
  packages/contracts/        @borg/contracts — command/event Zod schemas, no implementations
  packages/ui-kit/           Shared SolidJS kit used by shell and plugin UIs
  plugins/                   Bundled plugins (one folder each, same SDK)
  tests/e2e/                 Playwright
  tests/fixtures/            mock LLM transcripts, mock MCP, mock channels
  docs/research/hivemind.md  Slice 0 output
  docs/architecture.md       Slice 0 output
```

Discovery: bundled plugins from `plugins/` at build time; later, user plugins from an app-data `plugins/` directory. Same loader.

---

## 14. Kernel tool pipeline (normative)

Every tool call, whether from chat, a graph step, a bot, or MCP, goes through one path in the kernel:

```text
LLM/graph/bot requests tool
  → canonicalize tool id
  → persona allowlist + session exclusions
  → plugin permission check
  → data classification of args + destination channel class
  → approval protocol (auto | ask | deny)
  → sandbox selection (none | os | uv | node)
  → execute
  → classify result
  → cost/audit/events
```

Do not let a plugin execute tools behind this pipeline.

Tool/classification approvals: kernel protocol + default UI. Human questions: `borg.feedback` via the same `ctx.interactions` queue (`kind: human_input`). AFK: pending interactions survive window hide (tray indicator). The ask-user tool uses `approval: auto`.

---

## 15. Vertical slices

Implement **in this order**. Each slice is independently demoable. Do not skip tests.

A slice is done when: listed behavior works, listed tests pass, HiveMind mapping for that slice is reflected in `docs/architecture.md` (updated as you go), and no kernel/plugin boundary regression (product code did not land in the kernel).

### Slice 0 — Research and architecture

**Goal.** The rest of the repo has a map.

**Do**

- Deep-read HiveMind using §10 and the path list.
- Write `docs/research/hivemind.md`: what to copy, what to invert, loop vs workflow split, plugin SDK, flight deck, personas, approvals, classification, connectors, MCP Apps, knowledge graph, desktop UI structure, e2e setup.
- Write `docs/architecture.md`: module map, contribution types, **bus contract (§9.5) with the v0 catalog**, IPC, plugin lifecycle, persona schema, loop strategy interface, `ctx.interactions` kinds, `borg.feedback` vs kernel tool-approval split, graph engine **non**-LangGraph approach, tray lifetime, test strategy.

**Done when** those two docs exist and explicitly record the locked decisions in §2.

**Not in this slice:** application code beyond empty workspace scaffolding if needed to host the docs.

---

### Slice 1 — Boot, tray, loader, empty shell

**Goal.** Borg is a real desktop app that stays alive in the tray and can load an in-proc plugin into a UI slot.

**In**

- Electron app, main = kernel stub, preload IPC, SolidJS renderer shell
- Tray icon: Show, Hide, Quit; closing the window hides; Quit stops the process
- Plugin SDK: `definePlugin`, manifest, `engines.borg`, activate/deactivate
- Loader: discover `plugins/`, version check, in-proc activate in main + UI contributions in renderer
- Shell slots: main workspace, settings, wizard, flight deck (can be empty)
- Themes token plumbing (one default theme)
- Sample plugin `borg.hello` contributing a flight-deck widget (“kernel alive”)
- Bus v0: `defineCommand` / `handle` / `invoke` / `provides`; hello UI calls `borg.hello.getStatus` in main (proves main↔UI over the bus, not raw IPC)
- Vitest: load plugin, reject incompatible `engines.borg`; duplicate command id fails load; `invoke` with no handler → `unavailable`
- Playwright: app launches, widget visible (status from the command), hide window / show from tray (as far as OS automation allows; document any OS limit)

**Out:** chat, loops, models, persistence backends beyond in-memory.

---

### Slice 2 — Config, secrets, wizard, settings

**Goal.** Plugins can store config and secrets through facades; the wizard and settings are extension points.

**In**

- Kernel config + secrets facades
- Plugins: `borg.config.sqlite`, `borg.secrets.dev`, `borg.secrets.os`
- Settings window host + `settingsPage` contributions
- Setup wizard host + `wizardStep` contributions
- Notifications/toasts API
- Playwright: wizard completes with dev secrets backend; setting a plugin config persists across restart (restart = relaunch app; tray quit then start)

**Out:** model providers, chat.

---

### Slice 3 — Loop runtime, mock LLM, tools, approvals, ask-user

**Goal.** The kernel can run a ReAct turn with a scripted model, a registered tool, permissions, a tool-approval modal, and a **human question** — without a chat product UI yet (a minimal debug workspace view is OK, replaced in slice 4).

**In**

- Loop runtime API (ReAct required; CodeAct stub OK). LangGraph allowed here.
- `borg.mock-llm` with transcript fixtures (including “call `feedback.ask`, then continue”)
- Tool registry + pipeline (permission, approval, execute; classification can be “unlabeled” default)
- `ctx.interactions` queue; kernel default UI for `tool_approval`
- `borg.feedback`: tool `feedback.ask` (`approval: auto`), command `borg.feedback.ask`, `interactionRenderer` for `human_input`, tray/pending via the kernel queue
- Cost/token emit + store
- A tiny `borg.tools.echo` (or start `borg.tools.core` with one tool) for the transcript
- Contract tests: scripted tool call → approval required → grant → model final answer; deny path; cost recorded; `feedback.ask` waits, resolve, turn continues; `borg.feedback` disabled → `unavailable`
- Playwright: approval modal accept/deny; ask-user prompt → type answer → continue; hide to tray with a pending question → badge → show → answer

**Out:** personas UX, chat history, graphs, real providers.

---

### Slice 4 — Personas + chat (first real product slice)

**Goal.** HiveMind-like chat session as a **plugin**, using kernel personas and the slice 3 loop.

**In**

- Kernel persona model (HiveMind-like: id, instructions, models, allowed tools, loop strategy). Bundled default persona `system/general`
- `borg.chat`: session list, transcript UI, send/receive streaming events, session workspace folder + browser, sub-agent management (can be v1-minimal: spawn child session with same pipeline)
- Prompt assembly: persona slot + later slots empty
- Wire `borg.tools.core` filesystem tools scoped to the session workspace (copy HiveMind `filesystem.*` semantics)
- Chat registers a workspace view and a flight-deck “active sessions” widget
- Wizard/settings: pick mock LLM, create/select persona
- Chat listens to `borg.feedback.requested` / `resolved` and may `borg.chat.append` a transcript hint; it does **not** own the question UI
- Playwright journeys:
  1. Fresh profile → wizard → chat → send message → mock transcript replies
  2. Model asks for a file tool → approval → file appears in workspace browser
  3. Hide to tray mid-turn → turn completes → reopen shows the result
  4. Mock LLM calls `feedback.ask` → feedback UI → answer appears in the thread → turn finishes

**Out:** graphs, bots, MCP, real LLMs.

---

### Slice 5 — Graphs (HiveMind workflows, not LangGraph)

**Goal.** A graphs plugin that can design, persist, run, and be launched from chat — engine **not** LangGraph.

**In**

- Kernel services for graph-engine plugins: instance events, workspace allocation, interaction-queue hook, bus topics
- `borg.graphs`: definition store, executor inspired by HiveMind `WorkflowEngine`, designer UI (Cytoscape as in HiveMind)
- v1 step/trigger subset (expand later via `graphStep` / `graphTrigger` child plugins):
  - Triggers: `manual`, `schedule`, `incoming_message` (even if only a mock channel exists yet)
  - Tasks: `call_tool`, `invoke_agent`, `delay`, `set_variable`, `invoke_prompt`, `feedback_gate`
  - Control: `branch`, `for_each`, `end`
- `feedback_gate` invokes `borg.feedback.ask` (contracts), **not** chat. Hide-to-tray with a gate pending must still resolve.
- Agent tools to list/run/inspect graphs
- Chat → graphs via `borg.graphs.launch` (no direct import)
- Flight-deck widget for running graphs
- Tests: unit executor on a fixture graph; Playwright design a tiny graph, run it, see completion; chat launches via command; graph with `feedback_gate` → answer → graph completes; graphs plugin loaded without `borg.feedback` → gate step `unavailable`

**Out:** every HiveMind step type, MCP-notification trigger (slice 7), connector-driven inbound (slice 8).

**Forbidden:** `langgraph` dependency in this plugin.

---

### Slice 6 — Scheduler + bots

**Goal.** Background bots like HiveMind, surviving window hide, visible on flight deck and tray.

**In**

- Kernel scheduling core services (cron/timer, run log hooks)
- `borg.bots`: create bot from persona + launch prompt, start/stop, logs, tools to manage bots
- Bots use **kernel loops**, not a third executor
- Tray shows running bot count; flight-deck widgets
- Bots may call `feedback.ask` / `borg.feedback.ask` (same path as chat/graphs)
- Playwright: start bot with mock LLM transcript, hide window, bot completes, reopen + tray state; bot asks a question while window hidden → tray badge → answer → bot continues

**Out:** every connector as a bot trigger (wire `channel.inboundMessage` when slice 8 lands).

---

### Slice 7 — Real LLM plugin + cost UI

**Goal.** One production provider works end-to-end; mock remains the CI path.

**In**

- `borg.openai` **or** `borg.anthropic` first (then the other): setup UI, auth via secrets facade, tool-calling convention, token caching
- Settings/wizard steps from the provider plugin
- Cost/token display in chat + a flight-deck cost widget
- e2e against mock still green; provider plugin has contract tests with HTTP mocked at the plugin boundary

**Out:** Azure, Ollama, OpenRouter, Copilot — follow-on plugins, same `llmProvider` contribution.

---

### Slice 8 — MCP client + MCP Apps

**Goal.** MCP is a plugin; tools show up in a chat session; MCP Apps can render in chat without chat importing MCP internals.

**In**

- `borg.mcp`: stdio / SSE / streamable HTTP as in HiveMind, catalog, per-session tools `mcp.<server>.<tool>`
- Persona-owned MCP server list (kernel persona field, MCP plugin consumes it)
- `borg.mcp-apps` + bus contract with `borg.chat` for iframe/app-tool register/invoke/respond
- Mock MCP server fixture
- Playwright: enable mock MCP → tool appears → agent (mock LLM) calls it
- Playwright: MCP App tool round-trip if Apps are in this slice; otherwise document as slice 8b and keep the bus contract

**Out:** marketplace MCP registry polish can be thinner than HiveMind’s.

---

### Slice 9 — Classification, prompt scanner, channels

**Goal.** Trust path + communication plumbing + at least one connector plugin.

**In**

- Kernel classification enforcement in the tool pipeline and outbound channel send
- Approval UI for classification violations (kernel default)
- `borg.security.prompt-injection` scanner plugin hooked as `promptScanner` (kernel still enforces review/block)
- Communication core services (inbound/outbound message, dedup, routing to chat/graphs/bots)
- One **mock channel** plugin for tests
- Copy **one** real HiveMind connector as a plugin (IMAP or Discord is enough for the slice), then remaining connectors as follow-on plugins (one per connector: M365, Google, IMAP, Discord, …)
- Graphs `incoming_message` trigger wired to `channel.inboundMessage`
- Tests: classified-secret cannot go out a public channel without approval; mock inbound starts a graph; scanner review path with mock LLM

**Out:** every HiveMind connector in the same slice — land the pipeline plus one real + one mock, then clone the rest.

---

### Slice 10 — Memory, context maps, prompt slots

**Goal.** Agents recall graph + semantic memory; workspace context maps feed the prompt.

**In**

- Kernel memory abstractions (graph + semantic retrieve/write)
- `borg.memory.knowledge` — copy HiveMind knowledge-base concept
- `borg.context-map` — workspace summaries
- Prompt assembler uses persona + memory + context-map + plugin slots
- Chat/bots/graphs all recall through `ctx.memory`, not their own stores
- Tests: write memory in a session, recall in the next turn (mock LLM fixture asserts injected prompt contains the fact); context map includes a workspace file

---

### Slice 11 — Sandboxes + CodeAct

**Goal.** Tools and CodeAct run in kernel-provided sandboxes.

**In**

- Sandbox factory: OS-level, uv, Node.js
- `borg.tools.core` shell/code tools execute inside sandboxes
- CodeAct loop strategy in kernel (LangGraph OK)
- Tests: code tool cannot write outside sandbox root; uv and node runners execute a fixture

---

### Slice 12 — Search, A2A, remaining connectors, themes polish

**Goal.** Remaining HiveMind-parity plugins on top of a stable kernel.

**In**

- `borg.search.tavily`, `borg.search.brave` (HTTP mocked in tests)
- A2A plumbing in kernel + a plugin or kernel endpoint that exposes a persona/loop over the chosen A2A protocol
- Remaining channel plugins (one per HiveMind connector)
- Extra `llmProvider` plugins as needed
- Theme contributions; extra flight-deck widgets
- Playwright smoke of settings → enable search mock → chat tool call

After this slice, new work is more plugins, not more kernel — unless a contribution type is missing.

---

## 16. Research questions (slice 0 must answer)

1. How does HiveMind assemble a session tool registry (persona, MCP, plugins, connectors, exclusions)?
2. Exactly how do approvals, classification, and destination rules interact on one tool call?
3. What is the persona schema (fields, IDs, MCP, tools, loop strategy, skills)?
4. How does the workflow engine persist definitions/instances/step state, and which step types are load-bearing vs decorative?
5. How do bots differ from chat sessions and from workflow `invoke_agent`?
6. What does the plugin SDK actually allow today vs what HiveMind still implements in Rust?
7. How does the desktop app handle daemon lifetime vs window lifetime — and what is the Borg tray equivalent?
8. How are MCP Apps bridged through the UI?
9. How is the knowledge graph written and recalled into the prompt?
10. What Playwright setup do they use, and which journeys exist?
11. Which SolidJS patterns (stores vs `App.tsx`) should Borg copy vs avoid?
12. What A2A protocol, if any, does HiveMind approach — and what should Borg’s kernel plumbing implement?
13. How do `Question`, `UserInteractionGate`, and `workflow_gate` differ, and how does Borg’s single `human_input` path (`borg.feedback` + kernel queue) cover them without a second gate system?

---

## 17. Stop and ask

Ask the human; do not guess:

- Kernel vs plugin ownership that this spec does not name
- Adding a kernel dependency that is not Electron, SolidJS stack, Zod, or (for loops only) LangGraph
- Using LangGraph anywhere near the graphs plugin
- Out-of-process plugins (this spec forbids them for v1)
- A second event bus, sticky/replay events, multiple handlers per command id, or plugins importing each other
- Putting ask-user / feedback-gate UX in chat or in the kernel (it belongs in `borg.feedback`)
- Changing window-close-to-tray or putting personas in a plugin
- Dropping SolidJS for React
- Skipping a slice’s Playwright/contract tests
- Renaming “graphs” back to “workflows” in the product UI (code and UI say **graphs**; docs may mention HiveMind workflows as the inspiration)

---

## 18. Coding standards (short)

- TypeScript strict. No `any` on SDK boundaries.
- Public command/event schemas live in `packages/contracts` (`@borg/contracts`). Host/plugin types live in the SDK. Do not duplicate either inside a plugin.
- Tool IDs: HiveMind style, dot-separated (`filesystem.read`, `mcp.<server>.<tool>`, `plugin.<id>.<tool>`).
- Persona IDs: slash-delimited (`system/general`).
- Plugin IDs: reverse-dns (`borg.chat`).
- Prefer small modules. The renderer shell must not become HiveMind’s mega-`App.tsx`.
- Every new UI control used in tests gets `data-testid`.
- Do not add dependencies without justification; do not add a second CSS or state library.

---

## 19. Definition of done (whole v1)

Borg is a tray-resident Electron app. Kernel in main. Plugins in-process via `@borg/plugin-sdk`. Personas in kernel. Chat, graphs, bots, **human feedback**, models, MCP, connectors, memory implementation, search, and scanners are plugins. Cross-plugin wiring is the §9.5 bus + `@borg/contracts`. Graphs are a HiveMind-inspired engine **without** LangGraph. Loops may use LangGraph. Ask-user and feedback gates go through `borg.feedback` and the kernel interaction queue, including with the window hidden. Closing the window does not kill work. Mock LLM drives extensive UI e2e. A new contribution type is how you extend the product, not a kernel patch.
