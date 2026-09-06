# Borg architecture

## Status and authority

This is the implementation architecture through Slice 13. `init-spec.md` remains the product brief and source of locked decisions; this document makes those decisions implementable.

The architecture is deliberately a microkernel:

- Electron main owns process lifetime, trust boundaries, contracts, and generic runtime services.
- The renderer is a shell and a projection of main-process state.
- Product behavior is supplied by in-process plugins using `@borg/plugin-sdk`.
- Cross-plugin collaboration uses kernel contributions and the single typed command/event bus.

If implementing a feature requires adding chat, graph, bot, connector, MCP, model-provider, memory-provider, search, or scanner logic to `packages/kernel`, the boundary is wrong.

## Locked decisions recorded

The following are architectural constraints, not open design questions:

1. Electron main is the kernel. There is no Rust daemon or local client/server tier.
2. Closing the window hides it. The kernel, loops, graphs, bots, connectors, and schedulers continue. Only explicit Quit stops them.
3. Borg always has a tray icon with show/hide, pending-interaction state, running counts, and Quit.
4. Personas are kernel-owned and are consumed uniformly by chat, bots, graphs, MCP, and loops.
5. Plugins execute in-process. Bundled and future third-party plugins use the same manifest, SDK, validation, and loader.
6. Graphs are HiveMind-inspired workflows renamed in code and UI. `borg.graphs` owns a custom graph engine and must not depend on LangGraph.
7. The one kernel agentic-loop runtime may use LangGraph internally for ReAct/CodeAct if evaluation in Slice 3 shows a net benefit.
8. The renderer stack is SolidJS, Vite, Tailwind, Kobalte, lucide-solid, CodeMirror, and Cytoscape.
9. TypeScript is strict throughout.
10. A plugin cannot import another plugin package. It uses host APIs, contributions, and schemas from `@borg/contracts`.
11. There is one command/event bus, in main. Commands have one handler and Zod input/output; events have zero or more isolated subscribers and a Zod payload.
12. Tool and classification approvals are kernel safety protocols with fallback UI. Ask-user and graph feedback gates belong to `borg.feedback` and use the kernel interaction queue.
13. Classification, permission, approval, and outbound-channel enforcement run in the kernel on every relevant call.
14. Kernel persistence APIs are facades. Config, secret, and durable-store backends are plugins, and callers do not choose a backend.
15. A bundled plugin must load through the same SDK and loader path as any other plugin.

Electron itself uses a main process and Chromium renderer/utility processes. “In-process plugins” means plugin main code runs inside Electron main and plugin UI code runs inside the existing renderer; Borg does not add a daemon or one child process per plugin.

## Runtime topology

```text
Electron application
│
├─ main: Borg kernel
│  ├─ boot, tray, windows, graceful shutdown
│  ├─ plugin discovery, validation, activation, disposal
│  ├─ contribution registry
│  ├─ command/event bus
│  ├─ personas, permissions, classifications
│  ├─ loop manager and run registry
│  ├─ tool registry and invocation pipeline
│  ├─ interactions, notifications, audit, cost
│  ├─ config/store/secret facades
│  ├─ communication, scheduling, workspace, sandbox, A2A services
│  └─ active plugin main modules
│
├─ preload: fixed, typed kernel bridge
│  └─ no plugin-authored IPC channels and no Node exposure
│
└─ renderer: SolidJS shell
   ├─ chat-first chrome, navigation, themes, toasts
   ├─ sequential setup, settings, activity, and developer slots
   ├─ fallback safety interaction UI
   ├─ active plugin UI modules
   └─ snapshot + event projections of main state
```

There is one Borg application lifetime. Main starts before the window is useful and remains authoritative even if no window is visible. Renderer reload or failure must not terminate main-process work.

## Target repository layout

Slice 1 should establish this shape:

```text
apps/
  desktop/
    src/
      main/                 Electron entry, tray/window wiring
      preload/              fixed contextBridge surface
      renderer/             Solid shell and contribution hosts
packages/
  contracts/                @borg/contracts: Zod command/event/data schemas
  kernel/                   main-process kernel modules
  plugin-sdk/               @borg/plugin-sdk
  ui-kit/                   shared Solid components and tokens
plugins/
  hello/
    src/main.ts
    src/ui.tsx
tests/
  e2e/
  fixtures/
docs/
  research/hivemind.md
  architecture.md
```

Later bundled plugins get one directory each under `plugins/`. A plugin package may have `main` and `ui` entry points but has one identity, version, manifest, and configuration namespace.

## Kernel module map

| Module | Responsibility | Explicitly not responsible for |
|---|---|---|
| `Kernel` | boot order, service composition, ready/degraded/stopping state | product feature orchestration |
| `PluginManager` | discovery, manifests, compatibility, lifecycle, enable/disable | special-casing bundled feature behavior |
| `ContributionRegistry` | built-in and plugin-defined extension points, schema validation, lookup | command dispatch |
| `CommandEventBus` | typed commands/events, correlation, timeouts, subscriber isolation | tools, LLM streams, secrets, config |
| `IpcBridge` | fixed preload transport onto kernel APIs and the main bus | a renderer-side business bus |
| `PersonaService` | persona schema, validation, CRUD, defaults, selection | chat history or model HTTP calls |
| `PermissionService` | plugin host permissions and agent/tool policies | pretending in-process code is sandboxed |
| `LoopManager` | one loop runtime, strategy lifecycle, cancellation, streaming events | chat UI, bot definitions, graph scheduling |
| `RunRegistry` | generic live-run identity/status/counts for tray and Flight Deck | feature-specific run state |
| `ExecutionSecurityService` | durable execution lineage, classification, bounded provenance, and close/import rules | model transport or product persistence |
| `ModelGateway` | provider selection, model input/output scanning, egress authorization, usage attribution, and approved-result replay | provider HTTP/auth implementation |
| `ToolService` | tool contributions, discovery, canonical IDs, invocation pipeline | tool implementation |
| `InteractionService` | pending queue, wait/resolve/cancel, counts, renderer routing | ask-user wording or graph-gate semantics |
| `ClassificationService` | live run projection for tool and channel checks | durable execution classification |
| `PersistenceFacades` | config, plugin store, and secret routing | SQLite/keychain implementation |
| `CommunicationService` | normalized inbound/outbound records, dedup, attachments, routing, outbound gate | provider/connector transport |
| `SchedulerCore` | monotonic timers, cron wakeups, cancellation, run hooks | scheduling UX and feature job definitions |
| `WorkspaceService` | session/run workspace allocation and scoped handles | chat file browser |
| `SandboxFactory` | OS, uv, and Node sandbox construction | shell/filesystem tools |
| `PromptAssembler` | deterministic prompt slots and budgets; injects `kernel.memory` | memory/context-map construction |
| `MemoryFacade` | semantic write/retrieve and one `memoryProvider` | concrete knowledge database; graph entity APIs |
| `CostLedger` | process-session token/cost projection and queries | provider-specific pricing/auth or model-call ownership |
| `AuditService` | structured security and lifecycle audit records | product transcript |
| `NotificationService` | OS notifications and renderer toast events | feature-specific notification rules |
| `A2AService` | Agent2Agent server plumbing and task-to-loop mapping | persona/agent product UI |
| `WindowTrayService` | window visibility, tray menu/counts, application quit | product feature state |

Generic graph support in the kernel is limited to `GraphContributionRegistry`, `RunRegistry`, `WorkspaceService`, `SchedulerCore`, bus events, interactions, and store hooks. Definition validation, step scheduling, graph persistence shape, triggers, and designer behavior live in `borg.graphs`.

## Contracts and shared types

`@borg/contracts` contains:

- `defineCommand` and `defineEvent`;
- Zod schemas and inferred TypeScript types;
- stable cross-plugin data types such as inbound messages and graph run summaries;
- no handlers, services, UI components, or feature implementation.

`@borg/plugin-sdk` contains:

- plugin definition and manifest types;
- contribution and extension-point APIs;
- scoped main/UI host contexts;
- lifecycle/disposable helpers;
- a test harness;
- no bundled feature implementation.

Kernel implementation types that plugins do not consume stay in `packages/kernel`. Shared Solid components and tokens stay in `packages/ui-kit`.

## Plugin package and manifest

A static manifest is read and validated before either entry point executes. Its v0 shape is:

```ts
interface BorgPluginManifest {
  id: string;
  version: string;
  engines: { borg: string };
  main: string;
  ui?: string;
  permissions: string[];
  contributes: {
    commands?: string[];
    events?: string[];
    extensionPoints?: string[];
    kinds?: string[];
  };
}
```

`contributes.kinds` is an index for discovery, not the runtime contribution payload. Runtime payloads are registered during activation and validated by the owning extension-point schema.

Plugin IDs are reverse-DNS style within the product namespace, such as `borg.chat`. Tool IDs are dot-separated. Persona IDs are slash-delimited.

Bundled discovery uses build-generated manifest metadata from `plugins/`. Future user plugins are discovered from the application-data plugin directory. The source location changes; validation and activation do not.

### Versioning and compatibility

`engines.borg` is a required semver range. The loader parses it before import and tests it against the kernel host-API version. A missing/malformed range or unsatisfied range produces `incompatible`; prerelease kernel versions satisfy only ranges that explicitly include a prerelease. Incompatible plugins remain discoverable for diagnostics but neither entry point is imported.

An extension-point definition has its own schema version. A provider contribution names that version and must match a version currently accepted by the owner. Compatibility within a major version is governed by the Zod schema and documented optional-field rules. A breaking payload change increments the major version.

Supporting the immediately previous contribution-schema major is optional. If an owner does so, it registers an explicit, tested N-1-to-N adapter and emits a deprecation warning identifying the provider. There is no permissive coercion and no guarantee older than N-1. Bundled plugins must use the current schema major before release.

Command/event IDs are stable product contracts. A breaking payload change gets a new ID or a coordinated compatibility parser in `@borg/contracts`; it is not hidden inside a plugin implementation.

### Main and UI entries

The main entry uses `definePlugin` and receives a main `PluginContext`. It registers service contributions, handlers, tools, and background work.

The optional UI entry uses the same SDK's UI definition and receives `PluginUiContext`. It registers Solid components into declared shell extension points. It cannot import Electron or Node APIs and cannot call `ipcRenderer`.

Main validates and activates a plugin before exposing its UI module URL. The renderer imports active UI modules through a kernel-owned `borg-plugin:` protocol or packaged module map. The protocol serves only a validated plugin's declared UI entry and assets under the renderer CSP.

UI failure is quarantined and surfaced without stopping main-process background work. Main activation failure rolls back the plugin completely. A renderer restart reactivates UI entries against already active main plugins; it does not reactivate main entries.

### Lifecycle

Plugin state is:

```text
discovered -> validated -> activating -> active
                    \-> incompatible
                    \-> failed
active -> deactivating -> disabled
active -> failed
```

Activation is transactional:

1. parse the static manifest;
2. verify unique plugin ID, `engines.borg`, declared permissions, entry paths, and contribution declarations;
3. import the main entry without calling `activate`;
4. validate the `definePlugin` descriptor, its Zod config schema, and its agreement with the static manifest;
5. load and validate that plugin's namespaced config through the facade;
6. stage contribution and command ownership registrations;
7. call `activate(ctx)` with an `AbortSignal`;
8. commit staged registrations only if activation succeeds;
9. publish the active UI entry to the renderer.

Importing a module can execute JavaScript top-level code, so plugin authoring rules prohibit work outside `activate`. The loader cannot enforce that restriction as a sandbox; import throws are contained as activation failures and the plugin remains trusted installed code.

The selected bootstrap `configStore` follows a constrained variant because its facade does not exist yet: the loader imports and validates its descriptor, requires configuration that is empty or satisfiable from schema defaults, and activates it with only logger, platform, and scoped data-directory APIs. It may commit only its config/store provider contribution. Once that facade is installed, secret-store and ordinary plugins follow the full sequence above.

If activation throws, the manager aborts the plugin, disposes staged registrations in reverse order, records a typed failure, and leaves the app running. Duplicate command ownership is an activation/load failure, never last-write-wins.

Deactivation:

1. stops new calls into the plugin;
2. aborts its signal;
3. waits for registered background work up to a kernel deadline;
4. calls `deactivate`;
5. disposes handlers, subscriptions, timers, contributions, and UI entries in reverse order.

Every registration returns a disposable and is also tracked by the plugin scope, so cleanup does not depend on perfect plugin code.

### Failure isolation

The kernel wraps plugin lifecycle methods, command handlers, event subscribers, contribution callbacks, and tool handlers. Promise rejection becomes a structured error and is logged with plugin/correlation IDs. A failing event subscriber does not fail the emitter.

This is JavaScript error isolation, not a security or native-crash sandbox. Main-side third-party code can import Node APIs and can crash or bypass host wrappers if malicious. V1 therefore treats an installed plugin as trusted local code and clearly displays requested permissions before enablement. Host API permission checks protect well-behaved or buggy plugins; they do not make in-process code untrusted.

## Contribution registry

The registry is distinct from the command/event bus.

An extension point has an ID, owner (`kernel` or a plugin), a versioned Zod schema, multiplicity, and an optional selector policy. A contribution has an ID, provider plugin ID, extension-point ID, schema version, metadata, and runtime implementation.

Kernel-defined v0 contribution types are:

| Contribution | Selection/usage |
|---|---|
| `llmProvider` | many registered; `ModelGateway` selects by model, capacity, and preference |
| `tool` / `toolProvider` | many; `ToolService` exposes canonical tools or lazy catalogs |
| `workspaceView` | ordered renderer slot; chat is one view |
| `settingsPage` | ordered renderer settings section |
| `wizardStep` | dependency-ordered setup step |
| `flightDeckWidget` | ordered live widget |
| `theme` | selected by user; tokens validated by UI kit |
| `interactionRenderer` | at most one active renderer per interaction kind, with kernel fallback rules |
| `graphEngine` | many allowed; each graph definition names one, while graph creation uses a configured default |
| `botRuntime` | runtime contribution consumed by bot commands/UI |
| `channel` | normalized communication adapter |
| `searchProvider` | selected provider behind search tools |
| `memoryProvider` | selected implementation behind graph/semantic memory facades |
| `configStore` | exactly one bootstrap provider |
| `secretStore` | one selected provider, with platform/dev choices |
| `promptSlot` | ordered prompt contribution |
| `promptScanner` | zero or more; kernel combines scan results conservatively |
| `scheduler` | optional higher-level scheduling implementation on kernel timers |
| `mcpClient` | MCP transport/catalog implementation |
| `mcpApp` | session app resource/iframe implementation |
| `a2aEndpoint` | persona/skill exposure metadata consumed by kernel A2A |
| `command` / `event` | declaration/ownership metadata for bus contracts |

`borg.graphs` defines the versioned extension points `borg.graphs.graphStep` and `borg.graphs.graphTrigger`. Their public schemas live in `@borg/contracts`; child plugins contribute through the registry without importing `borg.graphs`.

When an optional contribution is absent, its consumer reports `unavailable` or hides the dependent control using capability lookup. Optional features do not create package dependencies.

## Command/event bus

There is one bus instance in Electron main.

### Commands

A command contract contains a stable ID, input Zod schema, output Zod schema, and timeout policy. A plugin may handle only a command listed in its manifest. Any loaded plugin may invoke a public command in v1.

Invocation:

1. resolve the contract and sole handler;
2. return `unavailable` if there is no handler;
3. parse input;
4. create an operation context and `AbortSignal`;
5. run the wrapped handler;
6. parse output;
7. return output or a closed error.

The closed command error codes are:

```text
unavailable | invalid_input | invalid_output | forbidden | timeout | failed
```

The default timeout is 30 seconds. Contracts for a deliberate human wait, such as `borg.feedback.ask` and MCP App invocation, declare an interaction timeout policy and remain pending until their own configured expiry or cancellation. Other long-running operations return an ID immediately and publish progress/completion events.

`provides(command)` means a compatible active handler is currently registered. It is capability discovery, not a cached guarantee; the invocation may still become unavailable if a plugin is disabled.

### Events

An event contract contains a stable ID and payload Zod schema. A plugin may emit only an event listed in its manifest. Multiple plugins may declare the same shared event contract, such as channel inbound messages.

Payloads are parsed before dispatch. Subscribers run asynchronously through wrapped handlers. Dispatch uses all-settled semantics, so one rejection does not affect the emitter or other subscribers.

V1 has exact event IDs only, no wildcards, no sticky values, and no replay. A renderer or plugin obtains current state with a command/host query and then subscribes to deltas.

### Correlation

Commands and events carry a kernel envelope outside their public payload:

```ts
interface BusEnvelope {
  correlationId: string;
  causationId?: string;
  source: { kind: "kernel" | "plugin" | "renderer"; id: string };
  timestamp: string;
}
```

A root action creates a correlation ID. Nested operations inherit it and set the causing operation/event ID. Logs, audit, interactions, cost records, runs, and Flight Deck traces use the same value.

### Prohibited bus uses

The following are host services or dedicated streams, not bus messages:

- tool execution;
- LLM provider invocation and token streams;
- secrets, config, and plugin stores;
- persona CRUD inside main;
- classification decisions;
- sandbox execution.

Commands/events are for cross-plugin product collaboration. Contributions describe capabilities. Host APIs expose kernel services. These mechanisms must not be collapsed into one EventEmitter.

## V0 public command/event catalog

| ID | Kind | Owner/emitter | Purpose |
|---|---|---|---|
| `borg.hello.getStatus` | command | `borg.hello` | prove main/UI command routing in Slice 1 |
| `borg.graphs.launch` | command | `borg.graphs` | start a graph and return its instance ID |
| `borg.graphs.listRunning` | command | `borg.graphs` | query active graph runs |
| `borg.graphs.instance.started` | event | `borg.graphs` | graph lifecycle delta |
| `borg.graphs.instance.completed` | event | `borg.graphs` | graph output available |
| `borg.graphs.instance.failed` | event | `borg.graphs` | terminal graph failure |
| `borg.graphs.step.completed` | event | `borg.graphs` | step trace for Flight Deck |
| `borg.chat.createSession` | command | `borg.chat` | create a persona-backed chat, atomically including its optional first message |
| `borg.chat.listSessions` | command | `borg.chat` | list root, child, or all sessions |
| `borg.chat.getSession` | command | `borg.chat` | read one session and transcript |
| `borg.chat.sendMessage` | command | `borg.chat` | append user input and start its loop |
| `borg.chat.append` | command | `borg.chat` | append a typed non-user transcript entry |
| `borg.chat.deleteSession` | command | `borg.chat` | durably delete a session |
| `borg.chat.spawnSubAgent` | command | `borg.chat` | create a child session through the same loop pipeline |
| `borg.chat.listWorkspace` | command | `borg.chat` | list session-scoped workspace files |
| `borg.chat.message.appended` | event | `borg.chat` | transcript entry was appended |
| `borg.chat.turn.started` | event | `borg.chat` | chat turn accepted a loop |
| `borg.chat.turn.completed` | event | `borg.chat` | durably finalized chat-turn delta |
| `borg.chat.session.updated` | event | `borg.chat` | session metadata/status changed |
| `borg.chat.session.deleted` | event | `borg.chat` | session was durably deleted |
| `borg.channel.inboundMessage` | event | channel plugins | normalized inbound communication |
| `borg.feedback.ask` | command | `borg.feedback` | ask and wait through kernel interactions |
| `borg.feedback.requested` | event | `borg.feedback` | human-input request was queued |
| `borg.feedback.resolved` | event | `borg.feedback` | human-input request was resolved/cancelled |
| `borg.mcp.appDiscovered` | event | `borg.mcp` | publish a validated app resource and its app-visible server tools |
| `borg.embeddedContent.registered` | event | `borg.mcp-apps` | project durable generic embedded content into chat |
| `borg.mcpApps.invokeTool` | command | `borg.mcp-apps` | invoke one app-visible tool through a fresh run scope |
| `borg.mcpApps.cancelTool` | command | `borg.mcp-apps` | cancel an active app-originated tool invocation |
| `borg.mcpApps.toolResponded` | event | `borg.mcp-apps` | record the succeeded, failed, or cancelled terminal response |

The initial schema shapes are:

```ts
// borg.hello.getStatus
input: {}
output: {
  pluginId: string;
  kernelVersion: string;
  status: "alive";
  startedAt: string;
  now: string;
}

// borg.graphs.launch
input: {
  graphId: string;
  sessionId?: string;
  input?: Record<string, unknown>;
}
output: { instanceId: string }

// borg.graphs.listRunning
input: { sessionId?: string }
output: {
  instances: Array<{
    instanceId: string;
    graphId: string;
    sessionId?: string;
    status: "running" | "paused" | "waiting";
    startedAt: string;
  }>;
}

// borg.chat.append
input: {
  sessionId: string;
  entry: {
    role: "system" | "assistant" | "tool" | "event";
    content: string;
    metadata?: Record<string, unknown>;
  };
}
output: { messageId: string }

// borg.channel.inboundMessage
payload: {
  channelId: string;
  messageId: string;
  threadId?: string;
  sender: { id: string; name?: string };
  text: string;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: number;
  }>;
  classification?: string;
}
```

`borg.graphs.launch` does not select an engine independently: it loads the stored graph definition and resolves that definition's `engineId`. A missing/inactive engine returns `unavailable`. Engine choice is made when a graph is created or migrated, which keeps retries and recovered instances on the same implementation.

Graph instance events carry `instanceId`, `graphId`, optional `sessionId`, and an ISO timestamp. Completion adds `output`; failure adds `{ code, message }`. Step completion carries `stepId` and optional outputs.

Feedback schemas are:

```ts
// borg.feedback.ask
input: {
  title?: string;
  prompt: string;
  form: "text" | "confirm" | "choice";
  choices?: Array<{ id: string; label: string }>;
  source: {
    sessionId?: string;
    runId?: string;
    instanceId?: string;
    stepId?: string;
  };
  timeoutMs?: number;
}
output: {
  interactionId: string;
  answer:
    | { kind: "text"; text: string }
    | { kind: "confirm"; confirmed: boolean }
    | { kind: "choice"; choiceId: string; text?: string };
}
```

`requested` carries the input plus `interactionId`. `resolved` carries `interactionId`, source, and status `answered | cancelled | timed_out`; answers are included only where the subscriber is permitted to see them.

The MCP Apps flow is:

```ts
borg.mcp.appDiscovered({
  sessionId,
  personaId,
  appInstanceId,
  serverId,
  resourceUri,
  html,
  csp,
  permissions,
  tools: [{ name, toolId, description, inputSchema }],
  sourceToolId,
  sourceToolName,
  toolInput,
  callResult,
  startedAt,
  completedAt,
  discoveredAt
})

borg.embeddedContent.registered({
  sessionId,
  content: { instanceId, rendererId, title, payload, createdAt }
})

borg.mcpApps.invokeTool({
  appInstanceId,
  invocationId,
  requestId,
  toolName,
  arguments
}) -> { requestId, result }

borg.mcpApps.cancelTool({
  appInstanceId,
  invocationId,
}) -> { cancelled }
```

`borg.mcp` reads and validates the `ui://` resource after its source tool completes. `borg.mcp-apps` stores the immutable snapshot and publishes only the generic embedded-content contract that `borg.chat` persists. The UI bridge accepts bounded JSON-RPC requests only from the expected nested frame, instance, channel, and nonce. Every app tool call creates a ToolService run scope constrained to the selected snapshot tool and persona; cancellation disposes that scope.

## IPC and preload

Only preload imports Electron IPC in the renderer side. `contextIsolation` is enabled, `nodeIntegration` is disabled, and the renderer is sandboxed.

The fixed bridge exposes:

- invoke/cancel a typed command;
- query `provides`;
- subscribe/unsubscribe to exact typed events;
- kernel bootstrap snapshots for shell state and active UI contributions;
- kernel-owned persona, interaction, plugin/config, and window APIs needed by the shell;
- no arbitrary channel send and no direct `ipcRenderer`.

Kernel-owned IPC channels are implementation details with a small fixed set:

```text
borg:command:invoke
borg:command:cancel
borg:event:subscribe
borg:event:unsubscribe
borg:event:deliver
borg:kernel:bootstrap
borg:kernel:call
```

`borg:kernel:call` accepts only an enumerated kernel service method and method-specific Zod schema. It is not a stringly typed general RPC escape hatch.

An event subscription creates a real subscriber on the main bus that forwards envelopes to one `webContents`. The UI SDK's listener map only demultiplexes these forwarded messages; it is not a second event bus and stores no authoritative state.

Main validates sender identity, contract ID, input, output, and subscription ownership. Navigation away, renderer destruction, or plugin UI disposal removes associated subscriptions and cancels outstanding renderer commands.

Same-plugin main/UI communication still uses public commands/events. A plugin cannot add IPC channels.

## Personas

The kernel persists and validates personas through `PersonaService`. The v0 model is:

```ts
interface Persona {
  id: string;                    // e.g. system/general
  name: string;
  description?: string;
  instructions: string;
  preferredModels: string[];     // ordered provider:model IDs or patterns
  secondaryModels?: string[];
  allowedTools: string[];        // exact IDs/globs, "*" means all
  mcpServers: McpServerConfig[];
  loopStrategy: "react" | "code-act";
  toolExecutionMode: "sequential-partial" | "sequential-full" | "parallel";
  skillIds: string[];
  contextMapStrategy?: "general" | "code" | "advanced";
  avatar?: string;
  color?: string;
  archived: boolean;
  bundled: boolean;
}
```

`McpServerConfig` records ID, enabled flag, transport (`stdio | sse | streamable-http`), command/arguments or URL, environment/header secret references, channel class, reconnect/reactive flags, and optional sandbox request. The kernel stores this persona-owned data. Slice 8 enforces transport, secret-reference, reconnect, and tool-approval behavior; `channelClass`, `reactive`, and `sandbox` remain forward-compatible metadata and are not security boundaries. Stdio servers therefore execute as host-user child processes until the planned sandbox service is connected to this path.

Persona IDs have at least two slash-delimited segments containing letters, digits, `_`, or `-`. `system/general` is bundled and always resolvable. Bundled personas may be edited/reset and archived but not deleted.

Skills referenced by a persona are persona assets managed with the persona record. Their instructions enter the prompt through the kernel's skills prompt slot. Installing/discovering richer skills may later be added as a plugin contribution without moving persona identity out of the kernel.

Sessions and bots store persona IDs, not copied provider clients or tool implementations. A loop takes a persona snapshot at start for deterministic behavior; later persona edits affect new runs.

## Model routing and the single loop runtime

`llmProvider` contributions implement model discovery, authentication/setup metadata, completion, tool-call translation, token caching, and raw usage. Each provider declares a local or HTTPS egress destination and a classification capacity. They do not decide whether a request may cross that boundary.

`ModelGateway`:

- resolves persona preferences and snapshots one provider registration;
- scans the canonical provider input, including messages and tool definitions;
- authorizes the durable execution classification against provider capacity;
- gives the provider a one-shot permit that rechecks classification immediately before generation or network egress;
- holds raw provider output in memory until completed content and tool calls pass output scanning and authorization;
- records usage once and stores only approved terminal results for replay;
- rejects reused operation keys whose canonical request digest changed;
- treats dispatched or output-pending calls as indeterminate after restart.

Plugins that need a non-agent auxiliary completion use `ctx.models.complete` with an execution ID and stable operation key. This API never supplies tools. A tool-using or multi-step task uses `ctx.loops`; plugins do not build private model loops or call providers directly.

`LoopManager` owns:

- start, pause-at-safe-point, resume, cancel, get, list, and subscribe;
- run IDs and lifecycle state;
- conversation/context limits and cancellation;
- strategy selection;
- model requests through `ModelGateway` and approved token projection;
- tool-call dispatch exclusively through `ToolService`;
- structured-output validation;
- cost/audit correlation.

The public strategy boundary is:

```ts
interface LoopStrategy {
  readonly id: "react" | "code-act";
  run(context: LoopStrategyContext, signal: AbortSignal): AsyncIterable<LoopEvent>;
}
```

`LoopStrategyContext` exposes the selected provider through kernel adapters, conversation/prompt input, available tool definitions, structured-output schema, budgets, and a callback to the kernel tool pipeline. It never exposes plugin tool handlers directly.

ReAct is required in Slice 3. CodeAct can be a stub until Slice 11. LangGraph may be used behind this interface only if it works cleanly in Electron main, does not leak into SDK contracts, and replaces rather than duplicates loop state. There must never be a LangGraph-backed loop beside an unrelated home-grown product loop.

Loop events include run state, model start/token/end, tool-call arguments/start/result, interaction wait, compaction, usage, final output, cancellation, and failure. Provider chunks do not enter this stream. A `model_token` event means the completed output passed kernel policy and is safe to display.

Chat, bot, graph-agent, scanner-assisted, context-map-assisted, and A2A callers all use this manager or the auxiliary no-tool model API.

## Tool service and security pipeline

Tools are registered as contributions. The registry owns definitions and wrapped handlers. Consumers receive definitions and call `ctx.tools.invoke`; they cannot obtain or execute a handler.

Every invocation follows:

```text
request
 -> canonicalize tool ID
 -> resolve run/session/persona and current registry generation
 -> persona allowlist and session exclusions
 -> calling plugin/feature permission check
 -> classify arguments and determine destination channel
 -> combine tool default, permission, destination, and classification policy
 -> one approval interaction if needed
 -> select/create kernel sandbox
 -> wrapped handler execution with AbortSignal
 -> classify result and raise run high-water mark
 -> parallel-batch recheck where applicable
 -> cost, audit, trace
 -> result
```

The combined decision is `auto | ask | deny`. Any deny wins. Any ask wins over auto. A classification mismatch contributes its reason and override options to the same request rather than producing a second modal.

Tool definitions include ID, description, Zod input/output, side-effect/read-only annotations, channel class/destination resolver, default approval, requested sandbox, and provider plugin ID.

The `feedback.ask` definition has `approval: auto` because answering the question is the gate. It still passes identity, permission, classification, and auditing checks.

Plugins cannot execute another plugin's tool through imports or a handler reference. Tool-oriented graph steps, bots, MCP proxies, and chat loops all call the host API. A malicious in-process plugin can still bypass host APIs with direct Node code; this is the acknowledged trusted-plugin limitation, not a reason to weaken the normal pipeline.

## Interactions and human feedback

`InteractionService` is a kernel queue with kinds:

```text
tool_approval | classification | human_input
```

Creating an interaction is kind-restricted:

- only kernel safety code may request `tool_approval` or `classification`;
- `human_input` may be requested only by the active `borg.feedback.ask` command handler while handling that command, with `interactions.request:human_input` declared;
- all other plugins and features invoke `borg.feedback.ask` or the `feedback.ask` tool.

The permission alone is insufficient without the command operation context. Plugins may receive scoped list/subscribe/respond capabilities needed by their renderer, but those do not grant creation rights. This preserves one human-input path, including feedback settings and requested/resolved events, without placing ask-user behavior in the kernel.

Each record has:

- unique ID and state `pending | answered | denied | cancelled | timed_out`;
- kind, title, prompt, form schema, and choices;
- typed source containing plugin, feature, session/run/graph/step/tool-call IDs;
- correlation/causation IDs;
- created/expiry/resolved timestamps;
- response schema;
- matching renderer contribution ID.

`request()` validates the record, inserts it, updates counts/tray state, emits a queue delta, and returns a promise. `respond()` validates the response and atomically lets the first terminal response win. Duplicate/stale responses return a conflict. Abort or Quit removes the pending waiter with a typed cancellation.

The queue lives in main and is independent of window visibility. Hiding the window does not dispose it. V1 does not promise that an arbitrary pending JavaScript promise survives application Quit/restart. Durable owners such as `borg.graphs` persist their waiting state and recreate the interaction during recovery.

The kernel ships fallback renderers for `tool_approval` and `classification`. These work even if all product UI plugins are disabled. There is no kernel fallback for `human_input`.

`borg.feedback`:

- registers `feedback.ask` with text/confirm/choice forms and automatic tool approval; its handler invokes `borg.feedback.ask` so all human input follows the same command path;
- handles `borg.feedback.ask`;
- creates `human_input` requests through `ctx.interactions`;
- contributes the `human_input` renderer and pending-questions Flight Deck widget;
- emits requested/resolved events;
- owns timeout, focus-stealing, and notification settings.

If it is disabled, the tool is absent and the command is `unavailable`. A graph `feedback_gate` fails with that error. Kernel safety approvals continue to work.

Chat may subscribe to feedback events and invoke `borg.chat.append` for transcript hints. It does not own, duplicate, or answer the prompt.

## Persistence and bootstrap

Callers use three facades:

```ts
ctx.config.get/update/watch           // schema-validated plugin config
ctx.store.get/set/delete/list/transaction
ctx.secrets.get/set/delete/has
```

All keys are automatically namespaced by plugin ID. Store operations support atomic transactions and prefix listing so graph state can be checkpointed without exposing SQLite APIs. Secret values never enter config documents or bus/event payloads.

Providers are contributions:

- `borg.config.sqlite` supplies `configStore` and durable plugin store behavior;
- `borg.secrets.os` supplies the production platform keychain;
- `borg.secrets.dev` supplies the explicit development/test choice.

Boot has a capability bootstrap phase:

1. discover and statically validate all bundled manifests;
2. select the sole compatible bootstrap `configStore` contribution by manifest capability, not by hard-coded plugin ID;
3. activate it with a minimal bootstrap context containing only logger, platform, and scoped data directory;
4. install config/store facades and load kernel/plugin enablement state;
5. activate the configured `secretStore`;
6. load personas and activate the remaining plugins in deterministic order;
7. mark the kernel ready and show/continue the wizard.

V1 ships one config-store candidate. Multiple equal-priority bootstrap stores are a configuration error, not last-write-wins. Secret-store selection can be persisted through the config facade.

The kernel has no production in-memory persistence fallback. Tests and Slice 1 may load fixture memory-store plugins through the same contribution interface. If durable config cannot start, the shell opens in a typed recovery state rather than silently losing data.

Backend plugins own their schema migrations. Facades own namespacing, access checks, value validation, and provider routing. Callers never name or import a backend.

## Classification, permissions, scanners, and communication

V0 supports an absent/unlabeled classification so early slices can run. Slice 9 enables the full ordered levels:

```text
public < internal < confidential < restricted
```

Channel classes are `public | internal | private | local-only`, with ceilings `public`, `internal`, `confidential`, and `restricted` respectively. A classification mismatch requires an explicit kernel approval. Effective run classification is a versioned high-water mark and cannot silently decrease. Approval commitments are invalidated if the high-water mark changes before the operation commits.

`promptScanner` contributions inspect inbound user/channel content and external tool/model content. Scanner results are advisory `allow | review | block` findings with bounded reason and evidence. The kernel executes matching scanners with content, timeout, and result bounds, isolates failures, and combines the findings. A block denies. A review asks once if the operation has not already prompted. Missing, disabled, timed-out, invalid, or failed coverage is fail-closed-to-review and never disables permission or classification enforcement.

Plugin host permissions include examples such as:

```text
network:<host>
fs:sessionWorkspace
fs:pluginData
secrets:read
secrets:write
ui.workspace
ui.settings
loops.start
tools.register
interactions.request:human_input
subprocess:uv
subprocess:node
channels.send
```

Every host API checks the active plugin scope and manifest declaration. Dynamic destinations, file scopes, and persona/session tool rules are checked again at operation time.

`CommunicationService` owns normalized message IDs, attachment handles, inbound deduplication, persistence, classification, bounded redacted audit records, inbound routing, outbound idempotency, and the final outbound authorization commitment. `channel` contributions implement transport-specific receive and send behavior but cannot emit inbound events or publish externally except through the scoped service callbacks supplied at registration.

Inbound flow:

```text
channel adapter
 -> normalize and deduplicate
 -> classify/scan
 -> persist/audit
 -> emit borg.channel.inboundMessage
 -> interested chat/graph/bot plugins
```

Outbound flow:

```text
feature/tool
 -> CommunicationService.send
 -> permission + destination + classification + approval
 -> selected channel contribution
 -> audit/result classification
```

`borg.channel.inboundMessage` is the sole normalized inbound event. Consumers opt in explicitly. Slice 9 graph definitions may bind `incoming_message` triggers to selected adapter IDs and destinations; no inbound message automatically starts a chat, persona, or bot.

`WebSocketService` is the only plugin WebSocket path. It checks `network:websocket`, accepts only credential-free `ws:` or `wss:` URLs, binds every connection to plugin deactivation, limits concurrent connections, outbound queue depth, and frame size, and emits redacted lifecycle audit records. It normalizes host callbacks behind a generation-safe disposable connection so stale transport events cannot outlive plugin ownership.

## Graphs plugin

`borg.graphs` is a first-class bundled plugin. It contributes a graph engine, workspace/settings/designer views, management tools, commands/events, and Flight Deck state. It also defines the graph-step and graph-trigger extension points.

### Canonical data model

The canonical persisted definition is JSON validated with Zod:

```ts
interface GraphDefinition {
  id: string;
  name: string;
  version: string;
  engineId: string;
  description?: string;
  mode: "background" | "chat";
  inputSchema: JsonSchema;
  variablesSchema: JsonSchema;
  nodes: GraphNode[];
  edges: GraphEdge[];
  output?: Record<string, string>;
  permissions?: PermissionRule[];
}

interface GraphNode {
  id: string;
  type: "trigger" | "task" | "control";
  kind: string;
  config: unknown;
  outputs?: Record<string, string>;
  onError?: GraphErrorStrategy;
  timeoutMs?: number;
  designer?: { x: number; y: number };
}
```

YAML may be offered as import/export, but JSON is the execution and persistence boundary. This avoids a YAML parser in the core graph path and maps directly to Zod, SQLite JSON values behind `ctx.store`, Cytoscape, and command payloads.

Slice 5 definitions use the bundled HiveMind-inspired engine ID. The ID is persisted in every definition and instance snapshot; a newly created graph receives the configured default, while import requires an explicit compatible engine or a deterministic migration.

Logical persisted collections are:

- stable graph identity and immutable definition versions;
- graph instance with definition snapshot/hash, trigger/input, variable bag, workspace, status, output/error, and timestamps;
- one state record per node with attempt, timing, outputs, error, child run ID, and wait metadata;
- trigger deduplication and schedule/event cursors.

The plugin uses transactional `ctx.store` checkpoints. The kernel does not know this schema.

### Executor

The custom executor:

1. validates node kinds/configs and graph reachability before save/run;
2. snapshots the selected definition into a new instance;
3. computes ready nodes from persisted predecessor/control state;
4. executes independent ready nodes with bounded concurrency;
5. checkpoints before and after every externally visible transition;
6. applies timeout and fail/retry/skip/go-to policy;
7. suspends on delay, event, or feedback waits;
8. resumes from persisted state and kernel timer/event hooks;
9. resolves graph output and publishes terminal events.

Long-running instances are detached from the command that launches them through the kernel-owned `PluginRuntime`; this prevents an expired command capability from being reused by later graph steps while still tying cancellation and shutdown to the owning plugin. Delay and recurring-trigger deadlines use owner-scoped `SchedulerCore` registrations. The plugin persists each deadline before registration and recreates it during activation, so hiding the window has no effect and process restart resumes from the checkpoint.

Base Slice 5 triggers are manual, schedule, and incoming message. Base tasks are call tool, invoke agent, delay, set variable, invoke prompt, and feedback gate. Control nodes are branch, for-each, and end.

- `call_tool` invokes `ctx.tools` and therefore the kernel pipeline.
- `invoke_agent` starts the one kernel loop runtime with a persona and graph workspace.
- `delay` registers a kernel timer and persists its deadline.
- `invoke_prompt` resolves a kernel persona prompt and starts a loop/auxiliary model call as appropriate.
- `feedback_gate` invokes `borg.feedback.ask`; it does not import chat or call `ctx.interactions` directly.
- `incoming_message` subscribes to `borg.channel.inboundMessage`.

A child plugin contributes step schema, editor metadata, validation, and a lifecycle-wrapped executor callback through `borg.graphs.graphStep`. Steps are treated as unsafe to replay after an indeterminate restart unless they explicitly declare `replaySafe`. Trigger contributions provide a lifecycle-wrapped subscription that launches the owning graph through the same persisted instance path. The designer reads contribution descriptors through `borg.graphs.listContributions`; the graphs plugin asks the kernel registry for executable contributions and never imports the child package.

The `plugins/graphs` package must have an automated dependency assertion that rejects `langgraph` and any plugin-package import.

## Product plugin boundaries

### `borg.chat`

Owns session persistence, transcript, workspace browser, streaming projection, sub-agent UX, main workspace view, and active-session widget. It invokes kernel loops and tools, consumes kernel personas, and owns `borg.chat.append`. It does not own interactions, personas, graph execution, models, or MCP.

### `borg.bots`

Owns durable bot definitions, launch prompts, restore/start/stop, logs, management tools, UI, and widgets. Bots use kernel loops and can invoke feedback. A bot is not a separate executor.

### Model plugins

One plugin per provider owns auth/setup, HTTP protocol, tool-call conversion, caching, and provider tests. `borg.mock-llm` is loaded exactly like a real provider and is the only CI model.

### `borg.mcp` and `borg.mcp-apps`

`borg.mcp` owns stdio/SSE/streamable-HTTP clients, catalogs, persona-config consumption, session tool providers, and validated `ui://` resource discovery. `borg.mcp-apps` owns durable app snapshots, sandboxed frames, app-tool proxies, and invocation correlation. Chat consumes a generic embedded-content renderer contract and does not import either MCP plugin.

MCP server annotations are untrusted metadata. They do not grant automatic approval or mark a call safe to replay. Every MCP tool call, including an MCP App call, enters the normal kernel approval path. An indeterminate transport failure is returned without retrying the tool. Network MCP servers may use plain HTTP without secret headers for local development. Header secret references require HTTPS unless the destination is an explicit loopback host.

The kernel accepts a closed JSON Schema keyword set. It enforces each supported assertion, accepts `format` and the standard descriptive fields as annotations, and rejects every other keyword. The `format` annotation does not reject a tool input.

MCP App content runs in an inner `sandbox="allow-scripts"` `srcdoc` inside an opaque-origin `borg-embedded:` outer sandbox. The outer document is a static Electron protocol response; validated app HTML reaches it only through the nonce-bound bridge. The inner document inherits the outer deny-by-default CSP, while an Electron session request filter denies nonlocal requests from the embedded frame tree even after an in-frame navigation. Both documents deny network, nested frames, forms, objects, workers, media, base URLs, referrers, and host capabilities. The narrow `postMessage` bridge validates source windows, origins, channel, app instance, per-frame nonce, JSON-RPC shape, depth, and byte limits. Requested app permissions and server-provided CSP domains are untrusted metadata and grant no capability in Slice 8. App calls require the configured server to remain available; there is no offline replay of MCP results or app writes.

### Tools, search, memory, context, scanners, stores, and channels

Each is implemented by its named plugin contribution. Setup/config UI ships with the owning plugin. Flight Deck data is contributed as widgets rather than hard-coded into a monolithic component.

Web search is two ordinary tool plugins, `borg.search.tavily` and `borg.search.brave`. There is no `SearchFacade` and no `searchProvider` contribution kind. Each plugin registers `tavily.search` or `brave.search` only while `enabled` is true and an API key is stored. HTTP JSON is parsed at the plugin client boundary into `webSearchOutputSchema`. Tool metadata is `approval: "ask"`, `outputProvenance: "external"`, and `channelCapacity: "public"`. Production Tavily is `POST https://api.tavily.com/search`. Production Brave is `GET https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token`. `BORG_TAVILY_ENDPOINT` and `BORG_BRAVE_ENDPOINT` override those URLs only when `BORG_E2E=1` and the host is loopback.

`borg.channel.imap` is a `private` channel adapter with a fake transport and `borg.channel.imap.inject`. It registers only when enabled with host, username, and a stored password. M365, Google, and a kernel `SocketService` are not in this slice.

## Prompt assembly and memory

The kernel prompt assembler combines registered slots deterministically:

```text
kernel safety/protocol
persona instructions
active skills
memory recall
workspace context map
feature context (chat/graph/bot/A2A)
other plugin slots by priority and stable ID
current task/input
```

A prompt slot declares ID, phase, priority, maximum budget, cache key, source classification, and an async resolver. The assembler:

- snapshots the active slot set at run start;
- enforces token/character budgets;
- sanitizes structural delimiters;
- preserves source/classification metadata for audit;
- scans untrusted external slot content where policy requires;
- records omitted/truncated slots.

Plugins cannot mutate a shared prompt string or insert after final policy instructions.

`MemoryFacade` exposes semantic write/retrieve operations and selects one `memoryProvider`. Graph entity/edge APIs remain future work. `borg.memory.knowledge` implements semantic persistence through `ctx.store`. Retrieval always receives persona/session/classification scope and returns classified records plus provenance. The kernel injects recall as `kernel.memory`; the knowledge plugin does not register a prompt slot.

Chat, bots, graph agent steps, and A2A call the same memory facade. `borg.context-map` uses workspace handles and contributes a prompt slot. An advanced map that needs tool use starts a kernel loop; it does not run a private hidden tool executor.

## Cost, audit, and observability

Providers report normalized usage:

```ts
interface UsageRecord {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  amount?: number;
  currency?: string;
  correlationId: string;
  runId?: string;
}
```

`ModelGateway` is the only model-usage writer. `CostLedger` projects process-session totals for `cost.read`; plugins cannot create or edit usage records.

Audit records capture security decisions, plugin lifecycle, outbound sends, interactions, tool calls, and overrides. Sensitive arguments/results are represented by classification-aware summaries or hashes, not copied blindly.

`RunRegistry` gives the tray and generic Flight Deck shell live loop/bot/graph counts. Feature-specific detail comes from plugin widgets and commands.

## A2A

Borg targets Linux Foundation Agent2Agent Protocol v1.0.

Kernel `A2AService` is the JSON-RPC dispatcher. `dispatch(JsonRpcRequest)` is the product surface. `listen()` is optional, injectable through `createServer`, binds `127.0.0.1` only, and stays off until `borg.a2a` config `enabled` is true. Desktop main constructs the service and watches that plugin config. Bind failures log and leave `listening` false. They do not fail kernel bootstrap. Plugin context exposes read-only `a2a.snapshot()` so `borg.a2a.getStatus` can report live listen state. There is no `a2aEndpoint` contribution kind.

Accepted methods are `message/send` / `SendMessage`, `tasks/get` / `GetTask`, and `tasks/cancel` / `CancelTask`. `message/send` starts a kernel loop owned by `borg.a2a` and returns the working Task immediately. The A2A task id equals `LoopRunSnapshot.id`. Loop status maps as running/paused → working, waiting → input-required, completed, failed, and cancelled → canceled. Listening also serves `GET /.well-known/agent-card.json`.

Loop start security is a root bind with subject `{ kind: "a2a-task", id: messageId }`, classification `internal`, provenance plugin `borg.a2a`, and operation prefix `a2a/${messageId}`. `messageId` is a UUID. If a workspace is allocated, `WorkspaceService` uses owner `borg.a2a`.

Streaming, push notifications, and non-loopback binds are out of this slice.

## Window, tray, and shutdown

Startup order:

1. Electron single-instance lock;
2. kernel bootstrap and tray creation;
3. storage facades and main plugin activation;
4. window/preload/renderer creation;
5. UI contribution activation;
6. wizard or main workspace.

The window `close` handler checks a `quitting` flag. Normal close prevents destruction and hides the window. Tray Show restores/unminimizes/focuses it; Hide hides it. macOS activation/reopen shows it.

The tray displays:

- Show/Hide;
- pending interaction count/indicator;
- running loop, bot, and graph counts;
- Quit.

Counts come from `InteractionService` and `RunRegistry`, not direct imports of product plugins.

Quit is explicit and graceful:

1. set kernel state to stopping and reject new commands/runs;
2. cancel pending interaction waiters with `app_quit`;
3. request cancellation of loops and feature runs;
4. deactivate plugins in reverse activation order with deadlines;
5. flush config/store, cost, and audit providers;
6. destroy windows/tray and call `app.quit()`.

Force termination after the deadline is logged. Closing a window never starts this sequence.

## UI shell and visual language

The renderer shell owns:

- compact window chrome and navigation among chat, settings, and activity;
- a full-screen sequential setup host composed from ordered plugin steps;
- placement of product and developer contributions for progressive disclosure;
- workspace, categorized settings, and activity extension hosts;
- theme tokens and UI-kit providers;
- toasts and kernel fallback safety interactions;
- loading, incompatible-plugin, and kernel-recovery states.

It does not own feature commands, session/graph/bot state machines, connectors, or model logic.

Plugin UI uses `@borg/ui-kit`, Tailwind tokens, Kobalte primitives, and lucide-solid icons. It cannot add a CSS framework or a separate global state library. CodeMirror and Cytoscape are used only in feature views that need them.

Each feature keeps a small Solid projection store:

1. query a snapshot through a typed command/host API;
2. subscribe to exact deltas;
3. re-query after reconnect or sequence gap;
4. discard stale async responses;
5. dispose subscriptions with the UI contribution.

No mega-`App.tsx` or mega-Activity component is allowed. The shell iterates contribution descriptors; workspace contributions declare `primary` or `developer` placement, and adding a feature view does not add a plugin-specific central `Switch` branch. User-facing copy says chat or conversation; `session` remains the internal runtime and persistence term.

## Testing strategy

Testing is part of each slice's architecture.

### Contract and kernel tests

Vitest covers:

- manifest/schema validation and engine semver;
- transactional activation/rollback/deactivation;
- permission denials;
- duplicate command owner failure;
- command unavailable, timeout, cancellation, invalid input/output, and closed error mapping;
- event validation, many subscribers, and subscriber failure isolation;
- renderer subscription disposal;
- tool pipeline ordering and combined approval decisions;
- interaction first-response-wins and hide-window persistence;
- store/secret provider selection;
- no plugin-to-plugin imports.

### Plugin harness

`createTestHarness` supplies in-memory implementations of host APIs, fake time, deterministic bus/contracts, interaction responders, model transcripts, and contribution inspection. Every plugin tests activation, config validation, its main contributions, permission failure, and disposal.

### Loop and graph tests

`borg.mock-llm` uses scripted transcripts with deterministic text, tool calls, usage, errors, and delays. CI never calls a real model.

Loop tests cover approval grant/deny, classification, feedback wait/resume, cancellation, structured output, and cost.

Graph tests use fake timers and fixture definitions to cover readiness, parallel branches, retry/error paths, persisted wait/recovery, feedback unavailable, trigger deduplication, and terminal output. A dependency test forbids LangGraph in the graphs plugin.

### Renderer tests

Vitest tests Solid stores and components with the typed bridge mocked at its boundary. Tests assert snapshots/deltas, forms, empty/error states, and cleanup.

### Electron Playwright

Playwright launches the actual Electron app with a unique temporary user-data directory and fixture plugin set. Tests use the mock LLM and mock integrations. Controls required by a journey have `data-testid`.

Every UI slice has a happy path and an error/empty/approval path. Slice journeys are exactly those listed in `init-spec.md`; later slices do not replace earlier acceptance coverage.

Native tray menus are not uniformly automatable. Playwright can still:

- close the real BrowserWindow and assert it becomes hidden while main stays alive;
- exercise the same show/hide command handlers from Electron main;
- assert pending/running state through the kernel and visible window after show.

Platform-native icon/menu appearance remains a small documented manual check where OS automation cannot reach it.

No E2E assertion may accept arbitrary console errors, catch and ignore a missing feature, or pass by polling only a backend state when the acceptance criterion is visible UI.

GitHub CI runs type checking, source-only TypeScript coverage, and the complete Electron suite on macOS. Coverage excludes `.tsx` because renderer behavior is verified through Electron journeys; the V8 gate applies to executable `.ts` source with explicit statement, branch, function, and line thresholds. A manual workflow builds an unsigned macOS archive, launches the packaged app, completes setup, and opens the graph designer before uploading the artifact. Signing, notarization, and automatic updates remain release work.

## Slice discipline and boundary checks

A slice is complete only when:

- its listed user behavior works;
- contract/unit tests pass;
- required Playwright journeys pass;
- this architecture is updated for any thickened contract;
- no product implementation moved into the kernel;
- bundled features still activate through the normal loader.

Before starting a later slice, CI should enforce:

- no import whose source matches another `plugins/*` package;
- no `langgraph` dependency under `plugins/graphs`;
- no Electron IPC import outside main/preload;
- no Node/Electron import in renderer/plugin UI;
- public command/event schemas live only in `@borg/contracts`;
- SDK boundaries contain no `any`;
- every command handler and event emission was declared by its plugin.

Slice 0 introduced only this document and `docs/research/hivemind.md`. Slice 1 began application scaffolding after those decisions were accepted.

## Slice 1 implementation record

Slice 1 establishes:

- pnpm workspaces for `apps/desktop`, kernel/contracts/SDK/UI-kit packages, and bundled plugins;
- strict TypeScript 7 builds with CommonJS main/preload output and a Vite/Solid renderer;
- a single main-process `CommandEventBus` with Zod input/output, closed errors, timeouts, exact event subscriptions, and isolated subscribers;
- transactional in-process plugin activation, engine compatibility checks, declaration enforcement, reverse-order disposal, and incompatible/failed states;
- build-time discovery from each `plugins/*/package.json` `borg` descriptor, producing separate main and renderer catalogs while preserving one plugin identity;
- a fixed, sender-validated preload bridge for command invocation, capability lookup, bootstrap, and window actions;
- an always-present tray, close-to-hide behavior, explicit graceful Quit, and a kernel/plugin lifetime independent of window visibility;
- renderer extension hosts for primary/developer workspace views, categorized settings, sequential wizard steps, and activity widgets;
- the `borg.hello` plugin, whose UI widget obtains status by invoking `borg.hello.getStatus` through main rather than direct IPC;
- Vitest coverage for loader/bus contract failures and Playwright journeys against the real Electron app.

The generated catalogs are source-controlled for type checking and regenerated before every build. Bundled discovery metadata determines their contents; neither the kernel nor the shell contains hello-specific behavior.

Native tray menus do not expose a portable Playwright click API on macOS. Slice 1 therefore verifies the real menu model, closes the real `BrowserWindow`, proves main and `borg.hello` remain active, and calls the same show handler used by the tray. The native icon/menu appearance and physical menu click remain the documented manual platform check.

## Slice 2 implementation record

Slice 2 adds the first capability-bootstrap phase. Main statically selects the sole engine-compatible `configStore` contribution and activates it through a constrained loader context before any ordinary plugin. The bootstrap plugin may install only its config/store provider; config schemas must be empty/default-satisfiable at that stage. Once installed, the kernel activates the configured `secretStore` and then all ordinary plugins in deterministic catalog order.

The persistence implementation consists of:

- kernel-owned `ConfigFacade`, `StoreFacade`, `SecretFacade`, and `PersistenceRegistry`;
- schema-validated JSON config, serialized read-modify-write updates, scoped watchers, runtime provider/result checks, and automatic plugin namespaces;
- scoped JSON store operations with atomic provider-side transaction batches and prefix listing;
- `borg.config.sqlite`, backed by Node's SQLite API with WAL mode and separate config/store tables;
- `borg.secrets.os`, which encrypts values through Electron `safeStorage`, rejects Linux `basic_text`, validates ciphertext, and stores only encrypted blobs;
- `borg.secrets.dev`, an explicit plaintext development/test backend with a warning and owner-only file permissions.

Both secret plugins validate vault structure, use null-prototype maps, and serialize copy-on-write commits through unique, fsynced temporary files. The selected provider ID and wizard completion state are persisted under the kernel setup namespace. Production defaults to the OS backend; the isolated Electron acceptance environment explicitly selects the development backend.

Settings and wizard descriptors now carry ordering, and required wizard steps expose readiness to the shell. `borg.hello` contributes a schema-backed settings page whose Flight Deck message persists across application restarts. The selected secret plugin contributes its own required setup step and settings page. Completing setup is a shell capability, not a plugin command.

`NotificationService` validates requests, isolates subscribers/native delivery, publishes renderer toast events, and optionally invokes Electron OS notifications. Renderer host APIs are scoped by one-time plugin capability tokens from a single-consumption bootstrap snapshot; main resolves the namespace and permissions rather than trusting a renderer-supplied plugin ID. This is bug isolation for trusted in-process plugins, not a hostile-code sandbox.

If durable bootstrap fails, main still opens the renderer with an explicit kernel recovery state instead of leaving a tray-only process. Slice 2 tests cover facade validation/namespacing, concurrent config updates, provider selection, notification isolation, concurrent durable secret writes, plugin capability expiry, wizard readiness, development secret setup, renderer capability replay rejection, config/wizard persistence across tray Quit, and corrupt-SQLite recovery. The build also runs a plugin import-boundary check.

## Slice 3 implementation record

Slice 3 installs one small kernel-owned ReAct runtime rather than adding LangGraph. The current strategy is intentionally direct: `LoopManager` owns run identity, cancellation, state, model/tool turns, and replayable per-run subscriptions; `ModelRouter` selects an active `llmProvider` contribution and records normalized usage through `CostLedger`; `ToolService` is the only route from a loop or plugin to a contributed tool handler. Renderer plugins receive the same owner-filtered event stream through the fixed preload bridge instead of polling. Plugins that need a non-agent completion use permission-scoped `ctx.models.complete` with an empty tool catalog. This keeps the public strategy boundary independent of a framework and leaves room to replace the internal implementation if later CodeAct evaluation justifies it.

The Slice 3 tool pipeline enforces canonical registration, caller host permissions, kernel-owned per-run allowlists, Zod input/output contracts, `auto | ask | deny` policy, kernel approval interactions, abort propagation, and JSON-safe results. Callers cannot replace a run's allowlist. Tool and run-policy registrations carry revocation signals, are revalidated after approval and execution, and cancel pending approvals when removed. Approval prompts identify the tool without copying raw arguments into the shell; the owner-only loop event stream still carries validated JSON arguments for trace rendering. Classification is the explicit `unlabeled` baseline for this slice; scanners, destination policy, sandboxes, and audit records thicken the same pipeline in later slices instead of creating another executor.

`InteractionService` owns the main-process queue, first-response-wins resolution, form-specific validation, timeout/abort behavior, subscriptions, tray counts, and shutdown cancellation. Only kernel code can create safety interactions. The host grants `human_input` creation only to a plugin with `interactions.request:human_input` while its `borg.feedback.ask` command handler is active, tracked with async operation context. The shell always renders `tool_approval` and `classification`; `borg.feedback` contributes the only `human_input` renderer and pending-questions widget.

The bundled Slice 3 plugins use normal discovery and lifecycle paths:

- `borg.mock-llm` contributes the scripted `mock:scripted` provider and temporary loop-debugger workspace;
- `borg.tools.echo` contributes `tools.echo`, which defaults to approval-required;
- `borg.feedback` contributes the auto-approved `feedback.ask` tool, `borg.feedback.ask` command, requested/resolved events, human-input renderer, and Flight Deck widget.

Renderer loop calls and subscriptions remain capability-scoped to the owning UI plugin, and run reads/cancellation are owner-filtered in main. Pending interaction responses require the shell capability. Hiding the window leaves runs and interactions in main; the tray title and menu project live pending/running counts. Usage returned by a provider is recorded even when cancellation or provider revocation rejects the completion, terminal snapshots receive that accounting update, and monetary totals remain separated by currency. Plugin deactivation first revokes commands, tools, and models, aborts and drains tracked callbacks to a deadline, then disposes resources; a lifecycle change reloads the renderer so stale UI contributions and capabilities do not survive. Quit cancels loops and outstanding interactions before plugin disposal.

Contract tests cover approval grant/deny without execution, authoritative allowlists, registration revocation, usage and multi-currency cost records, replayable loop events, ask-user wait/resume, absent-feedback `unavailable`, response conflicts, cancellation races, operation-scoped loop starts, and interaction timeouts. Electron acceptance covers both approval choices, disabled-feedback behavior, typed human input, native window visibility, and hiding/reopening Borg while the tray title and queue retain a pending question.

## Slice 4 implementation record

Slice 4 makes personas an enforced loop input rather than optional metadata. `PersonaService` persists versioned, recursively immutable records, always resolves an active default, and ships `system/general` with the bundled offline model preference. Setup validates and edits that preference from the capability-discovered model catalog. `ModelRouter` publishes permission-scoped model descriptors and resolves each persona's ordered preference patterns against active providers. Every loop resolves a persona, rejects unsupported tool execution modes, assembles the kernel and persona system prompt through `PromptAssembler`, and intersects persona and request tool restrictions instead of allowing either layer to widen the other. Plugins can contribute namespaced, deterministically ordered prompt slots through the SDK.

`WorkspaceService` allocates owner- and session-scoped directories and rejects malformed IDs and symlink escapes. The bundled `borg.tools.core` plugin contributes `filesystem.read` and approval-gated `filesystem.write`; both are limited to the invoking run's workspace, validate physical paths, reject traversal and symlink ancestors, and normalize exposed paths to `/`. A plugin cannot inspect or release another plugin's workspace by reusing its session ID.

`borg.chat` owns versioned session documents and transcript entries in its scoped store. It serializes each session's creates, appends, loop transitions, deletion, and sub-agent spawning; allocates the workspace before publishing a session; recovers interrupted runs on activation; and records completed, failed, cancelled, and interrupted turns. A send durably appends the user entry, starts the kernel loop with the selected persona and conversation, persists the run association, and subscribes before projecting tokens and terminal state. Feedback requested/resolved events add transcript hints without moving interaction ownership out of the kernel queue.

The chat-first shell presents conversations as the product home, with token streaming, transcript history, friendly persona/status copy, optional generated-file inspection, and advanced child-session delegation. A new chat remains ephemeral until its first message, avoiding empty persisted records. Setup is a full-screen Welcome → Secure storage → Choose assistant → Ready flow adapted from HiveMind's stepper rather than a stacked plugin checklist. Settings and Activity remain plugin-composed, while developer contributions such as the mock loop debugger and hello diagnostics are explicitly placed under Advanced. Selection and loop-subscription generations continue to suppress stale async results, and the activity widget subscribes before reading its first active-session snapshot.

The fixed preload bridge now exposes capability-scoped persona, model-catalog, loop, and declared-event APIs. Main validates model read permissions and rejects event subscriptions that no active plugin declared. Renderer subscriptions are disposed with their plugin activation scope and when the sender is destroyed. `createTestHarness` in the SDK activates and deactivates a plugin against supplied host doubles, enabling direct lifecycle/persistence tests without weakening production context construction.

Slice 4 verification covers persona persistence/default integrity, prompt and model resolution, layered tool policy, workspace ownership and symlink defenses, chat lifecycle and deletion through the plugin harness, real token streaming, file approval and workspace projection, feedback in thread, persona creation, sub-agent sessions, hidden-window completion, Flight Deck counts, and all prior shell/recovery journeys.

## Slice 6 implementation record

Slice 6 extends `SchedulerCore` instead of adding a second timer service. One-shot deadlines stay owner-scoped. Cron expressions compute the next UTC minute, reuse the same arm/cancel path, and re-register after each fire unless cancelled. Run-log subscribers receive `started`, `completed`, and `failed` records for both once and cron work. Plugins reach cron through `ctx.scheduler.scheduleCron` behind `scheduler.manage`.

`LoopManager.countLive(ownerPluginId?)` is the tray's occupancy query. `Running tasks` is every live loop. `Running bots` is live loops owned by `borg.bots`. Ownership stays inside the loop manager and does not appear on `LoopRunSnapshot`. `RunRegistry` remains documented future work. Graph instance counts stay on the graphs Flight Deck widget.

`borg.bots` owns durable bot records, logs, start/stop/delete, management tools, the Bots workspace, and the running-bots widget. A start allocates a workspace, calls `ctx.loops.start` with the persona and launch prompt, and projects loop events into logs. A completed or cancelled loop leaves the bot stopped. Activation restores a persisted running bot by starting a new loop when the previous run is gone. Bots ask humans through `feedback.ask` on the existing kernel queue. Connector-driven bot triggers stay out of this slice.

Slice 6 verification covers cron re-arm and run-log hooks, bot create/start/idempotent-start/complete and restore-on-activate through the plugin harness, plugin import boundaries, and Electron journeys for hidden-window completion plus hidden feedback answered from the tray badge.

## Slice 7 implementation record

Slice 7 adds the first production `llmProvider` without changing the default persona or the deterministic mock path. `borg.anthropic` talks to the Anthropic Messages API with raw `fetch` from plugin main only. It owns auth, SSE streaming, reversible tool-name mapping, 5-minute prompt-cache markers, and a typed pricing table. The renderer may only `has/set/delete` the key. Connect and disconnect are main-side commands with no secret input or output. A saved key restores registration at activation without a startup network call. The provider is registered only while a key is available. Saving or replacing a key disposes any current registration so the UI cannot report connected until the new key is verified. Removal always deletes the secret and disposes registration.

Authenticated Anthropic `fetch` calls use `redirect: "error"` so a malicious or misconfigured redirect cannot exfiltrate the API key. Verification uses a non-billed `GET /v1/models/claude-sonnet-5` derived from the already-gated Messages endpoint; it does not accept an arbitrary verification URL and does not call `/v1/messages`. The plugin declares `network:api.anthropic.com`. Host-side enforcement of `network:<host>` remains a known architectural gap in this slice; Borg does not yet wrap plugin `fetch` in a permission-checked HTTP facade.

`ModelRouter` accepts a provider-neutral fallback preference list. Desktop main supplies `borg.mock-llm:mock:scripted`, so unqualified completions do not follow catalog insertion order after `borg.anthropic` is registered. Token records keep the invariant that `cachedInputTokens + cacheWriteTokens <= inputTokens`. Anthropic normalizes `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` into total `inputTokens` and prices the uncached, cache-hit, and cache-write slices separately.

Per-chat usage is one typed aggregate on the `borg.chat` session document, updated once per terminal run from the loop snapshot. Live chat totals may overlay the current run's owner-scoped usage events. Process-session totals stay in the in-memory `CostLedger` and are exposed through `cost.read` summary/subscribe host APIs. `borg.usage` contributes one Activity widget labeled for the current Borg session so chat, bot, and graph spend share the same ledger. Currencies stay separate. The global ledger is not persisted in this slice.

## Slice 9 implementation record

Slice 9 installs one kernel trust path shared by tools, loop content, and channels. `ClassificationService` owns the monotonic per-run watermark. `ScannerRegistry` runs plugin scanners but cannot authorize an operation. `TrustAuthorizer` merges tool policy, channel capacity, and scanner findings into one allow, deny, or approval decision. `ToolService` applies trustworthy static and dynamic-tool security metadata, raises the watermark after parsed results, scans external results, and rechecks approval commitments. Existing tools default to an internal result classification; MCP results are explicitly external and internal.

The post-Slice 9 hardening adds durable execution security without moving product behavior into the kernel. `ExecutionSecurityService` persists product-neutral roots and children, monotonic classification, bounded provenance, host-selected child result flow, and idempotent close state. Chat turns, graph instances, graph agents, and bot attempts persist their execution identity before background work starts. Legacy chat, graph, and bot records migrate with restricted classification. A missing bot loop becomes interrupted and never replays its launch prompt automatically.

All model paths now use `ModelGateway`. The gateway scans canonical input, checks the execution classification against provider capacity, and requires a one-shot dispatch permit immediately before provider work. Raw tokens remain in memory until completed output passes scanning and authorization. Denied content does not reach loop history, logs, returned errors, or durable storage. Approved graph prompt results may replay by stable operation key and request digest; dispatched and output-pending calls fail as indeterminate after restart.

`CommunicationService` registers channel adapters, provides the only inbound ingestion callback, normalizes and persists records before emitting `borg.channel.inboundMessage`, and deduplicates provider message IDs. Outbound sends use an idempotency key, persist the pending commitment before transport, authorize once, recheck classification immediately before publish, and store the terminal receipt. Persistence failures fail closed. The bundled mock adapter gives tests a deterministic public channel. The graph plugin subscribes to the typed event and starts only definitions whose `incoming_message` trigger binding matches.

`borg.security.prompt-injection` contributes deterministic bounded patterns for instruction replacement, prompt disclosure, encoded role markers, secret exfiltration, and tool takeover. It covers user input, inbound messages, external tool results, model output, and outbound messages. Review findings enter the default kernel classification UI; block findings never reach a plugin transport or model.

`borg.channel.discord` pins REST calls to `https://discord.com/api/v10`, stores the bot token only through `SecretFacade`, requires explicit channel allowlists, validates snowflakes, ignores every bot-authored message, and declares both the pinned REST host and `network:websocket`. Its realtime Gateway driver discovers Discord's allowlisted gateway host, handles Hello, jittered heartbeats, ACK watchdogs, Identify, sequence tracking, resumable sessions, Reconnect, Invalid Session, fatal close codes, bounded exponential backoff, session-start limits, and Discord's 120-frame-per-60-second send window. Each connection cycle has an abort controller and generation; deactivation cancels timers, disposes callbacks, closes sockets, and prevents stale reconnects. There is no polling fallback.

## Slice 10 implementation record

Slice 10 adds semantic memory recall without graph entity APIs. `MemoryFacade` selects one `memoryProvider`. `ctx.memory` registers that provider (`memory.provide`) and exposes `write` / `retrieve` (`memory.write`, `memory.read`). `PromptAssembler.assemble` is async. It injects kernel section `kernel.memory` (order 200) by calling `MemoryFacade.retrieve`, using the current user prompt when present and otherwise the session id. `borg.memory.knowledge` persists records through `context.store` and does not register a prompt slot. Retrieve ranking is case-insensitive substring and token overlap over stored texts; there is no sqlite-vec.

`borg.context-map` contributes prompt slot `borg.context-map.workspace` (order 300). Loop assembly binds the loop owner's `listFiles` onto `PromptSlotContext.workspace`. The slot omits when that handle is missing. `WorkspaceService.listFiles` stays owner-scoped.

`borg.chat` writes accepted user text through `ctx.memory.write` after `loops.start` so the current assemble cannot recall that same turn. A failed or missing memory write is logged and does not fail the chat turn. Host permissions are `memory.read`, `memory.write`, and `memory.provide`.

## Slice 11 implementation record

Slice 11 adds `SandboxFactory` with kinds `os`, `uv`, and `node`. Runs use `cwd` at a real directory root, a scrubbed environment, and `shell: false`. Node writes source under the root and spawns `process.execPath` with `--permission` filesystem allows limited to that root. uv is injected in tests so CI does not require a host install. `ctx.sandbox.run` requires `sandbox.run`. `borg.tools.core` adds `code.run` and `shell.exec`, which execute inside the factory using the session workspace as the root.

`LoopManager` accepts persona `loopStrategy` `code-act`. That path still uses the same run IDs, pause points, and `ModelGateway`. Each turn either runs a fenced javascript/python block in the sandbox or treats unfenced content as the final answer. LangGraph is not used.

## Slice 12 implementation record

Slice 12 adds remaining HiveMind-parity plugins on the existing kernel. `A2AService` lives in `packages/kernel`. Search, IMAP, and appearance stay plugins. There is no extra `llmProvider`, `SearchFacade`, `HttpServerService`, `ThemeService`, or OAuth.

`borg.search.tavily` and `borg.search.brave` contribute ask-approved search tools. `borg.a2a` stores enabled/port/personaId and a Flight Deck widget. `borg.channel.imap` copies mock inject plus Discord enable-when-configured. `borg.themes` writes `theme: "dark" | "light"` and the UI plugin sets `document.documentElement.dataset.theme`. Light tokens live on `:root[data-theme="light"]` in the shell stylesheet. Dark remains the default.

The Electron journey enables Tavily in settings, chats `scenario:search`, approves `tavily.search` if asked, and expects the assistant text from the first result title.

## Slice 13 implementation record

Slice 13 adds `borg.openai` as the second production `llmProvider` without changing the kernel, default persona, or mock path. The plugin talks to pinned `https://api.openai.com/v1/chat/completions` with raw `fetch`, Bearer auth, `redirect: "error"`, Chat Completions SSE, and a frozen GPT-5 Mini / Nano / GPT-5 catalog. Connect verifies with a non-billed `GET /v1/models/gpt-5-mini` derived from the completions URL. A saved key restores registration at activation with zero fetches. Wizard and settings order is 26 so Anthropic remains the first optional LLM step (order 25). `BORG_OPENAI_ENDPOINT` is honored only when `BORG_E2E=1` and the host is loopback.
