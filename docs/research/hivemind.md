# HiveMind research for Borg

## Scope and source basis

This document records the Slice 0 source review required by `init-spec.md`. It treats HiveMind as a behavior and UX reference, not as Borg's process or ownership model.

- Repository: `https://github.com/hivemind-os/hivemind`
- Reviewed revision: `8ce52e05de35fbb379fa3a3b25e772914dd12680`
- Revision date: 2026-09-01
- Primary sources: `ARCHITECTURE.md`, `CLAUDE.md`, implementation code under `crates/`, the TypeScript plugin SDK under `packages/plugin-sdk/`, and the SolidJS desktop app and tests under `apps/hivemind-desktop/`

Some prose in `TESTING_GUIDE.md` is aspirational or uses stale paths. Findings below prefer current source, current test configuration, and executable tests over that guide.

## Executive findings

HiveMind is a local daemon product with a Tauri/SolidJS client. `hive-api` composes the services and `hive-chat` has become the interactive runtime hub: it resolves personas, assembles prompts and tools, owns live sessions, recalls memory, and connects the loop to approvals and the UI. Product workflows do not use the chat loop engine. They use a separate persisted `hive-workflow::WorkflowEngine`.

Borg should copy these behaviors:

- per-persona, per-session dynamic tool availability;
- persona identity, model preferences, tool policy, MCP ownership, loop choice, and skill association;
- a high-water-mark data classification model and destination-aware outbound checks;
- approvals and human questions that can remain pending while the window is hidden;
- persisted graph definitions, immutable run snapshots, step state, retry/error policy, trigger deduplication, and recoverable waits;
- tray-resident desktop behavior, Flight Deck observability, graph designer interactions, and deterministic mock-driven journeys;
- provider, connector, MCP, memory, and prompt-injection patterns as replaceable capabilities.

Borg should invert these architectural choices:

- Electron main replaces the Rust daemon, HTTP API, and Tauri bridge;
- chat, graphs, bots, models, MCP, connectors, memory implementations, context maps, and scanners become in-process plugins;
- the kernel owns one loop runtime, one tool policy pipeline, one interaction queue, and one command/event bus;
- graph execution remains a dedicated persisted engine in `borg.graphs`, but it is not LangGraph and does not become a second agentic loop;
- ask-user and graph feedback gates use one `borg.feedback` path instead of HiveMind's separately aggregated question and workflow-gate paths;
- renderer business state is not concentrated in a single `App.tsx`.

Electron necessarily has a main process and one or more Chromium renderer/utility processes. In Borg, “no separate process tier” therefore means no daemon and no per-plugin child processes, not literally one operating-system process.

## Reference topology

The current HiveMind runtime is:

```text
SolidJS renderer
  -> Tauri commands/events and authenticated HTTP/SSE proxying
Tauri host
  -> local authenticated daemon
hive-daemon
  -> hive-api AppState and routes
  -> hive-chat -> hive-loop::legacy
  -> hive-workflow-service -> hive-workflow::WorkflowEngine
  -> model, tools, MCP, connectors, plugins, knowledge, risk, scheduler
```

Useful composition sources are:

- `crates/hive-daemon/src/main.rs`
- `crates/hive-api/src/lib.rs`
- `crates/hive-chat/src/chat.rs`
- `crates/hive-loop/src/legacy/`
- `crates/hive-workflow/src/`
- `crates/hive-workflow-service/src/lib.rs`
- `apps/hivemind-desktop/src-tauri/src/lib.rs`
- `apps/hivemind-desktop/src/App.tsx`

## Answers to the Slice 0 research questions

### 1. Session tool registry assembly

The runtime tool set is rebuilt for a turn rather than taken from one global static registry.

Session creation in `crates/hive-chat/src/chat.rs` resolves a persona, creates a session workspace, seeds session permissions, and constructs a `SessionMcpManager` from that persona's MCP configuration. During turn processing, `build_session_tools()` constructs a fresh `ToolRegistry` from:

1. core orchestration and human-question tools;
2. filesystem tools rooted at the session workspace;
3. shell, process, HTTP, utility, knowledge-query, scheduling, and per-session data-store tools;
4. communication, calendar, drive, contacts, and dynamically discovered connector service tools;
5. graph/workflow management tools when the workflow service is available;
6. MCP tools from the catalog, limited to server IDs enabled in the session MCP manager;
7. tools bridged from running TypeScript plugins, filtered by plugin/persona association.

The implementation is at `crates/hive-chat/src/chat.rs::build_session_tools`. MCP registration goes through `hive_tools::register_mcp_tools`; plugin tools go through `hive_plugins::register_plugin_tools`.

After assembly:

- `ToolRegistry::filtered` applies persona `allowed_tools`, including glob patterns;
- `ToolRegistry::exclude` removes per-message/session exclusions;
- app-defined MCP iframe tools are injected later in `process_session()`, from `ChatSessionRecord.app_tools`.

There are two notable exceptions in HiveMind: `core.*` and `mcp.*` are automatically retained by `ToolRegistry::filtered` even when not named in `allowed_tools`. Session exclusions can still remove them. Borg should copy dynamic assembly, but follow its normative pipeline and apply the effective persona/session policy to every tool. `feedback.ask` is auto-approved, not policy-exempt.

There is also a child-agent inconsistency: `ChatPersonaToolFactory::build_tools_for_persona()` passes `["*"]` into `build_session_tools()` instead of the child persona's `allowed_tools`. Connector, MCP, and plugin discovery remains persona-scoped, but the final allowlist does not. Borg must not copy either this bypass or the unconditional `mcp.*` retention.

Tool discovery for the desktop is separately assembled in `crates/hive-api/src/routes/tools.rs`. This creates a risk that runtime availability and UI listing drift. Borg's contribution registry should be the shared source for both discovery and runtime resolution.

### 2. Approval, classification, and destination rules

HiveMind has two related trust paths.

Before a chat turn:

- `ChatService::enqueue_message()` resolves the persona and effective model choice;
- the user input is classified;
- the risk service scans for prompt injection;
- the request may be allowed, require review, or be blocked before it enters the loop.

For each tool call, the active legacy path is split between `crates/hive-loop/src/classification_middleware.rs` and `crates/hive-loop/src/legacy/tool_execution.rs`:

1. `before_tool_call` hooks run first. `DataClassificationMiddleware` compares the session's effective data class with the tool's channel class. A mismatch is hard-denied only when the resolved tool policy is `Deny`; otherwise it is deferred to inline approval.
2. `execute_tool_call` resolves the tool and canonical ID, infers its resource scope, and combines session permission rules with the tool's default `Auto | Ask | Deny`.
3. For `comm.send*` tools, connector destination rules are applied: `Deny` blocks, `Ask` requires approval, and `Auto` does not weaken an existing ask.
4. If tool policy requires approval or the tool's channel cannot carry the current data class, one `ToolApproval` interaction is created. Without an interaction gate, the call is denied.
5. `comm.send_external_message` then performs a separate resolved outbound-class check, which can produce a second approval prompt.
6. Special loop-owned tools such as `core.ask_user` are intercepted; otherwise the registered tool executes.
7. `after_tool_result` hooks run. Risk scanning may block or redact prompt-injection findings in tool output. Workspace classification and high-water escalation apply only to `fs.read`, `fs.read_document`, `filesystem.read`, and `filesystem.read_document`; other tool results do not raise the high-water mark through this middleware.
8. After a parallel batch, results are rechecked against the final high-water mark and unsafe results are redacted.

The base classification model is in `crates/hive-classification/src/model.rs`:

- data classes: `public < internal < confidential < restricted`;
- channel classes: `public`, `internal`, `private`, `local-only`;
- channel classes cap the maximum data class they may carry.

`crates/hive-classification/src/gate.rs` separately defines an override-policy helper with `block`, `prompt`, `allow`, and `redact-and-send` actions, defaulting to prompt for internal/confidential and block for restricted. That helper is not invoked by the active legacy tool-call path above, so its defaults are not the effective tool-call behavior at this revision.

Useful behavior to retain is the high-water model, scope-aware permission matching, destination-specific escalation, result classification, and parallel TOCTOU re-check. Borg should classify every result and should not retain the split checks that can produce two prompts for one outbound call. The kernel tool pipeline should calculate one effective decision from permission, classification, destination, and tool defaults, then create at most one typed interaction explaining all reasons.

Prompt-injection scanning remains a plugin capability in Borg, but classification, permissions, approval, and outbound enforcement remain kernel checks. A missing or disabled scanner must not bypass the kernel gate.

### 3. Persona schema and semantics

The current `Persona` type is in `crates/hive-contracts/src/config.rs`. Its effective schema contains:

- `id`: namespaced, slash-delimited ID with at least two segments, such as `system/general`;
- `name`, `description`, `system_prompt`;
- `loop_strategy`: `react`, `sequential`, `plan_then_execute`, or `code_act`;
- `tool_execution_mode`: sequential-partial, sequential-full, or parallel;
- `preferred_models`: ordered strings/globs, with backward compatibility for singular `preferred_model`;
- `secondary_models`: preferences for auxiliary model work;
- `allowed_tools`: exact IDs or globs;
- `mcp_servers`: persona-owned MCP server configurations;
- `avatar`, `color`;
- `context_map_strategy`: general, code, or advanced;
- `archived`, `bundled`;
- MCP sampling enablement, per-request approval, and maximum-token policy;
- reusable prompt templates.

`McpServerConfig` contains `id`, one of `stdio | sse | streamable-http`, command/arguments or URL, environment values, plain or secret-reference headers, channel class, enable/auto-connect/reactive/reconnect flags, and optional stdio sandbox policy.

Skills are associated with a persona by the skills service and on-disk persona namespace, rather than embedded as a simple field in the Rust `Persona` struct. `ChatService::skill_catalog_for_persona` builds the catalog, and per-turn exclusions can remove skills.

The default persona is `system/general`, ReAct, sequential-partial tool execution, all tools, no MCP servers, and general context maps.

Borg should keep the identity and policy concepts but use `instructions` as the canonical field name, ordered model references, explicit `skillIds`, and an MCP server list. Persona records and validation belong to the kernel. Model, MCP, context-map, and skill implementations consume those fields through host APIs or prompt slots; they do not own the persona.

### 4. Graph/workflow definitions, persistence, and execution

HiveMind's product workflow engine is `crates/hive-workflow`, integrated by `crates/hive-workflow-service`. It is unrelated to the generic workflow traits also present in `hive-loop`.

`WorkflowDefinition` contains a stable ID, namespaced name, version, description, chat/background mode, JSON Schema for variables, steps, output expressions, optional result message, requested tools, permission defaults, attachments, and tests. A `StepDef` contains ID, flattened trigger/task/control type, output expressions, error strategy, successor IDs, timeout, and designer coordinates.

The current step catalog is:

- triggers: manual, incoming message, event pattern, MCP notification, schedule;
- tasks: call tool, schedule task, invoke agent, signal agent, feedback gate, event gate, launch workflow, delay, set variable, invoke prompt;
- control: branch, for-each, while, end workflow;
- errors: fail workflow, retry, skip with default output, or go to another step.

`crates/hive-workflow/src/store.rs` uses SQLite. Important persisted records are:

- definition identity and version rows, storing both source YAML and normalized JSON;
- an instance with a definition snapshot, mode, status, variables, permissions, workspace, trigger, output/error, and timestamps;
- one row per step state, including retries, outputs, child run IDs, wait request metadata, and delay deadline;
- trigger deduplication, cron cursors, runtime cursors, shadow-mode intercepted actions, and successful-definition-run hashes.

Instance states include pending, running, paused, waiting on input/event, completed, failed, and killed. Step states add skipped, waiting for delay, and loop-waiting.

`crates/hive-workflow/src/executor.rs`:

- persists an immutable definition snapshot into each instance;
- computes ready steps from completed predecessors and explicit control-flow edges;
- runs independent ready steps concurrently under a semaphore;
- persists transitions and outputs;
- records retry/error strategy state;
- suspends on feedback, event, or delay waits;
- restores timers and resumable states;
- resolves output expressions and a final result message.

`crates/hive-workflow-service/src/lib.rs` supplies product adapters for tools, agents, scheduling, events, prompts, feedback, attachments, and workspace allocation. It publishes instance/step lifecycle events and cleans up workflow-owned child agents.

The load-bearing ideas for Borg are stable/versioned definitions, run snapshots, explicit step state, dependency-based readiness, bounded parallelism, persisted wait metadata, retries, trigger deduplication, workspace ownership, and lifecycle events. Designer coordinates, prose result messages, shadow previews, and palette details are useful UX but not engine fundamentals.

At revision `8ce52e05`, none of the 19 trigger/task/control variants is merely decorative: each has a runtime path. For Borg, their implementation priority is:

- Slice 5 load-bearing base: `manual`, `schedule`, and `incoming_message` triggers; `call_tool`, `invoke_agent`, `delay`, `set_variable`, `invoke_prompt`, and `feedback_gate` tasks; `branch`, `for_each`, and `end_workflow` controls.
- Useful follow-on extensions: `event_pattern` and `mcp_notification` triggers; `schedule_task`, `signal_agent`, `event_gate`, and `launch_workflow` tasks; the `while` control.
- Designer-only metadata, rather than a step type: X/Y coordinates. Palette grouping and prose result messages are also presentation concerns.

“Follow-on” describes Borg's vertical-slice scope, not an incomplete HiveMind implementation. Event and MCP-notification triggers have service paths; child-workflow launch, persistent event gates, signaling, event triggers, and while loops also have workflow test coverage. The reviewed revision has no dedicated workflow test for the MCP-notification trigger.

Borg should use a canonical JSON object validated by Zod and stored through `ctx.store`; YAML can be import/export later. This avoids YAML being an execution boundary in an all-TypeScript product while preserving the same graph model. The custom scheduler/executor belongs entirely to `borg.graphs`; it must not depend on LangGraph.

### 5. Bots versus chat sessions and graph `invoke_agent`

Chat sessions are user-facing conversation containers. `hive-chat` owns their queued messages, transcript projection, session workspace, active persona, MCP manager, session permission state, and event stream.

Bots are persisted background agent configurations managed by `crates/hive-chat/src/bot_service.rs`. A bot has a persona-like agent specification, launch prompt, mode, model/tool policy, permission rules, active flag, timeout, and its own workspace. Active bots are restored on daemon startup, use the same `LoopExecutor` as agents, keep event/journal logs, and can receive later tasks or feedback. They run under a bot supervisor rather than a normal chat-session supervisor. HiveMind currently stores bot configuration and journal material in the knowledge graph.

A workflow `invoke_agent` is a step-scoped child execution. It names a persona and task, can be synchronous or asynchronous, has step timeout/permissions/attachments, stores its child agent ID in step state, and is cleaned up with its owning workflow. It is not itself a durable bot product.

For Borg:

- `borg.chat` owns chat sessions and transcript/workspace UX;
- `borg.bots` owns durable bot definitions, restoration, controls, and views;
- `borg.graphs` owns graph step state and invokes kernel loops for agent steps;
- all three use kernel personas, the same loop manager, the same tool pipeline, and the same interaction queue.

### 6. Plugin SDK today versus Rust-owned product behavior

The public SDK is a connector SDK, not a general product extension system. Sources are under `packages/plugin-sdk/src/`.

It currently offers:

- `definePlugin`;
- Zod config schema plus UI metadata extraction;
- optional OAuth/token auth metadata;
- tool definitions with Zod parameters and annotations;
- one optional background loop;
- activate/deactivate hooks;
- context APIs for incoming messages, secrets, plugin KV, logging, notifications, custom events, status, scheduling, proxied HTTP, plugin data files, host info, connector listing, and persona listing;
- `createTestHarness` with in-memory captures for tools, loops, lifecycle, messages, events, config, secrets, storage, logs, notifications, and status.

The Rust host under `crates/hive-plugins` starts one Node child process per enabled plugin and uses JSON-RPC 2.0 over stdio. Lifecycle is initialize, activate, optionally start a loop, list tools, bridge tools as `plugin.<pluginId>.<tool>`, stop/deactivate. Install metadata is persisted separately from the running process.

The SDK cannot contribute workspace/settings/wizard/Flight Deck UI, model providers, graph engines or steps, memory, MCP clients, themes, prompt slots, schedulers, secret/config backends, or typed cross-plugin commands. Chat, loops, workflows, models, MCP, knowledge, search, most connectors, and all desktop screens remain Rust or app code.

Several declared SDK APIs are not production capabilities at this revision:

- plugin `emitMessage` is captured by tests, but the production host drops its message receiver and does not route it through connector classification/deduplication;
- proxied HTTP, plugin filesystem calls, and connector/persona listing are declared but not implemented in the production host handler;
- scheduling creates host events, but the callback path into the plugin is not wired, and the SDK stores scheduled handlers in a different map from the one its callback reads;
- SDK host calls do not consistently carry plugin identity, so production secret/store scoping can fall back to `"unknown"`.

Consequently, tools, custom events, lifecycle, status, and portions of secret/KV access are the mature path; the advertised connector-style host context is only partially end-to-end. Borg should treat the SDK surface as an ergonomic design reference, not proof that each capability works.

Borg should copy `definePlugin`, Zod-driven config forms, scoped host context, cancellation-aware lifecycle, and the test harness. It must replace stdio JSON-RPC with direct in-process calls, expand contribution types, add engine compatibility and declared host permissions, and use the kernel command/event bus for cross-plugin collaboration.

### 7. Desktop lifetime and Borg's tray equivalent

HiveMind now has close-to-tray behavior in `apps/hivemind-desktop/src-tauri/src/tray.rs`:

- close requests are prevented and the main window is hidden;
- the tray can show/focus the window;
- macOS reopen shows the window;
- Quit exits the Tauri app;
- tray controls independently start, stop, and restart the daemon.

The daemon remains a separate service. Quitting the desktop does not inherently mean stopping the daemon, which is why daemon controls exist in the tray.

Borg should copy close-to-tray, show/focus, reopen, updater-safe close handling, and a continuously refreshed status surface. It must invert lifetime ownership: Electron main is the kernel, so the hidden window and active kernel are one app lifetime. Explicit Quit must stop loops, graphs, bots, connectors, and schedulers, deactivate plugins, flush stores, and then exit.

The Borg tray specifically contains Show/Hide, a pending-interaction indicator/count, running loop/bot/graph counts, and Quit. These values come from kernel interaction/run registries so the tray does not import product plugins.

### 8. MCP Apps bridge

HiveMind has a global MCP service/catalog and per-session MCP managers. Persona-owned MCP server configuration determines the session view. Tool IDs are normalized as `mcp.<server>.<tool>`.

MCP Apps add browser-provided tools:

1. an MCP tool result identifies an app resource that the desktop renders in a sandboxed iframe;
2. the iframe registers app tools for a session and app instance;
3. `ChatService::register_app_tools` stores those definitions on the live session;
4. on the next turn, `process_session()` adds `AppToolProxy` entries such as `app.<instance>.<tool>`;
5. a proxy creates an `AppToolCall` interaction and publishes an invocation event;
6. the desktop routes the request to the matching iframe bridge;
7. the iframe result is posted back and resolves the waiting interaction.

Relevant sources include `crates/hive-chat/src/chat.rs` app-tool registration/injection, `hive_tools::AppToolProxy`, MCP app-tool API routes, and the desktop MCP App host/frame components.

Borg should keep the session/app-instance identity, sandboxed iframe, registered tool descriptors, request correlation, and asynchronous response. `borg.mcp-apps` owns the iframe bridge and proxy behavior; `borg.chat` only associates the rendered app with a session through contracts. Neither plugin imports the other.

### 9. Knowledge graph write and recall

`crates/hive-knowledge/src/lib.rs` implements a SQLite property graph:

- nodes have type, name, content, classification, and timestamps;
- edges have source, target, type, and weight;
- FTS supports lexical retrieval;
- `sqlite-vec` tables support per-model embeddings and nearest-neighbor search;
- graph reads respect a maximum data class;
- `KgPool` and write guards serialize writes where needed.

Chat persists session/message/workspace entities and edges into the graph. For recall, `ChatService::recall_memories`:

1. builds an FTS query from the user input;
2. searches classified-accessible `chat_message` nodes;
3. best-effort embeds the query and performs vector search;
4. merges lexical and vector ranks with reciprocal-rank fusion;
5. boosts nodes owned by the current session;
6. injects the selected memories into the turn prompt.

`hive-workspace-index` writes file/chunk structure and embeddings into the same graph. `hive-context-map` separately walks the workspace and builds a prompt map. Its general/code strategies are structural; its advanced strategy runs an auxiliary model with local read/search helpers and caches by a workspace fingerprint.

Important limitations are that the graph is one global `knowledge.db`, auto-recall searches only `chat_message` nodes, and session ownership is a rank boost rather than hard isolation. The generic `MemoryManager`/`memory` node API has no production caller outside its own tests. Workflows have no direct recall path, while bots reach memory largely through chat persistence/adapters. Context compaction summarizes old turns in-context but does not extract them back into the graph.

Memory use is not uniformly abstracted across every HiveMind product path. Chat is the main recall owner; bots and workflow agents reach knowledge through chat/agent adapters. Borg should expose graph and semantic interfaces in the kernel, implement HiveMind-like storage in `borg.memory.knowledge`, and have chat, bots, and graph agent steps call the same `ctx.memory` abstraction. Context-map construction belongs to `borg.context-map` and contributes a prompt slot.

### 10. Playwright setup and journeys

The desktop package has three distinct Playwright modes:

- `playwright.config.ts`: Vite-hosted UI harness with mocked Tauri APIs, two workers;
- `playwright.integration.config.ts`: Vite UI plus a real test daemon, global setup/teardown, one worker;
- `playwright.cdp.config.ts`: actual Tauri/WebView2 binary through CDP, Windows-only and serial.

Tests cover sidebar/navigation, session management, chat, workspace browsing, graph designer and graph pages, bots, scheduler, settings, knowledge, Flight Deck, accessibility, stress, themes, and dialogs. The integration fixtures exercise workflow/agent questions, a multi-agent ask-user plus separate feedback gate, and an inbound-email trigger, but the first two create/launch, poll, answer, and verify completion through daemon APIs after merely loading the app. They are backend-driven integration checks rather than proof of their named visible chat journeys.

The current suite contains good fixture and selector ideas, but some UI-harness assertions are permissive and several scenarios poll APIs directly instead of proving the visible journey. Borg should use Playwright's Electron launcher against the real Electron app on macOS/Windows/Linux, a unique profile per test, `borg.mock-llm`, deterministic fixture plugins, and strict visible assertions. Native tray-menu clicks may require platform-specific/manual coverage; close-to-tray and show-window handlers can still be tested through the Electron main process.

### 11. SolidJS patterns to copy and avoid

Useful patterns:

- feature stores made from Solid signals and memos, such as `workflowStore.ts`, `botStore.ts`, `interactionStore.ts`, and workspace/config stores;
- push subscriptions with a snapshot query on mount/reconnect;
- sequence counters that discard stale async responses;
- reusable Kobalte-backed UI primitives and Tailwind token classes;
- lazy loading for heavy views;
- `data-testid` on durable interaction controls;
- dedicated graph designer/editor components.

Patterns to avoid:

- `apps/hivemind-desktop/src/App.tsx` remains a multi-thousand-line composition root with many unrelated signals, backend calls, subscriptions, and screen branches;
- `FlightDeck.tsx` also aggregates many domains and duplicates formatting/types;
- screen and tab unions require central edits;
- some state is duplicated between App, feature stores, and components;
- direct Tauri command strings and frontend-shaped backend DTOs are spread widely.

Borg's renderer shell should contain layout, navigation, extension slots, theme/toast plumbing, and kernel fallback interactions. Each product plugin contributes its own Solid view and local projection store. Authoritative state remains in main, reached through typed SDK/bus contracts.

### 12. A2A protocol

No A2A/Agent2Agent implementation or crate is present in the reviewed HiveMind workspace. HiveMind has internal agent supervisors and signaling, but that is not an interoperable A2A network protocol.

Borg should target the Linux Foundation Agent2Agent (A2A) Protocol v1.0, the current successor to the Google-originated protocol named in the brief. The minimum kernel plumbing should provide:

- an Agent Card derived from an exposed persona/endpoint contribution;
- the JSON-RPC HTTP binding on localhost by default;
- send message, streamed message/task updates, get task, list tasks, subscribe, and cancel;
- mapping from A2A task IDs to kernel loop run IDs;
- authentication hooks and classification enforcement before any non-local binding.

Official specification reviewed: `https://a2a-protocol.org/v1.0.0/specification/`.

### 13. Question, UserInteractionGate, and workflow_gate

These are three different things in HiveMind:

- `Question` is an `InteractionKind` in `crates/hive-contracts/src/interaction.rs`. The loop-owned `core.ask_user` tool has automatic tool approval, emits this interaction, and waits for an answer.
- `UserInteractionGate` is the loop-side pending-promise mechanism used by a chat session or supervised agent. It correlates tool approvals, questions, and MCP app tool calls with responses.
- `feedback_gate` is a workflow step. The graph engine persists `WaitingOnInput` plus prompt/choices/request metadata in workflow step state and resumes through a workflow-specific response method.

`crates/hive-api/src/routes/interactions.rs` synthesizes one pending-interactions view from session questions, bot questions/approvals, and separately queried workflow gates. The desktop's `interactionRouting.ts` still sends answers to three different endpoint families. The integration test `02-multi-agent-approval-persona.spec.ts` drives both paths through their separate daemon APIs; it does not assert the visible chat routing its title and comments describe.

Borg should unify only the human-input behavior:

```text
feedback.ask tool or graph feedback_gate
  -> borg.feedback command/handler
  -> kernel ctx.interactions request(kind = human_input)
  -> one pending queue and one renderer
  -> answer resolves the caller
```

Tool approvals and classification violations use the same kernel queue but remain kernel-owned safety protocols with fallback UI. Disabling `borg.feedback` removes `feedback.ask` and makes `borg.feedback.ask` unavailable; it must not disable safety approvals.

## HiveMind-to-Borg ownership map

| HiveMind behavior/source | Retain | Borg owner |
|---|---|---|
| daemon/API composition | disciplined service lifecycle | Electron main kernel |
| chat sessions and workspace | session semantics and UX | `borg.chat` |
| legacy ReAct/CodeAct | strategy behavior and loop events | kernel loop runtime |
| workflow engine/designer | persisted graph execution and designer UX | `borg.graphs` |
| bots | durable background agents | `borg.bots` |
| personas | identity and policy model | kernel |
| model providers | provider-specific setup and tool calling | one LLM plugin per provider |
| tool registry | dynamic availability and stable IDs | kernel registry/pipeline plus tool plugins |
| Question and workflow gate | human wait semantics | kernel queue plus `borg.feedback` |
| connector services | normalized messages and capabilities | channel plugins plus kernel communication service |
| MCP and MCP Apps | transports, catalog, session tools, iframe bridge | `borg.mcp` and `borg.mcp-apps` |
| risk/classification | scans, labels, channel/destination policy | scanner plugin plus kernel enforcement |
| knowledge/context map | graph/vector recall and workspace maps | memory/context-map plugins plus kernel interfaces |
| plugin SDK | Zod config, context, lifecycle, harness | expanded in-process `@borg/plugin-sdk` |
| Tauri desktop | visual language, tray, Flight Deck, tests | Electron shell and plugin UI contributions |

## Research conclusions that constrain implementation

1. One kernel tool pipeline must mediate chat, graph, bot, MCP, and app-proxy calls.
2. One interaction queue must own pending state and tray counts; human questions are supplied by `borg.feedback`.
3. One loop runtime must serve chat, bots, graph agent steps, and A2A.
4. `borg.graphs` needs its own persisted graph scheduler, not LangGraph.
5. Contributions and typed commands/events replace direct plugin imports and duplicated UI/backend registries.
6. UI state should be a projection of main-process state, with snapshot-plus-delta subscriptions.
7. Mock providers and fixture integrations are product architecture, not test-only afterthoughts.
8. In-process third-party main modules are trusted installed code in v1. Host API permission wrappers do not constitute a security sandbox against a malicious plugin that imports Node APIs directly.
