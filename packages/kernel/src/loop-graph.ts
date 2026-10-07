import {
  Annotation,
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { JsonValue, ModelMessage, ModelToolCall } from "@borg-agent/plugin-sdk";

/**
 * LangGraph counts a step per node visit, and its default limit is 25.
 * A tool or sandbox round is two visits, so the product turn budget has to
 * raise that limit or a long run stops inside the library first.
 */
function cycleConfig(maxTurns: number, signal: AbortSignal): {
  readonly recursionLimit: number;
  readonly signal: AbortSignal;
} {
  return {
    recursionLimit: maxTurns * 3 + 5,
    signal,
  };
}

export interface ModelCycleResult {
  readonly content?: string | undefined;
  readonly toolCalls?: readonly ModelToolCall[] | undefined;
}

interface CycleHost {
  readonly maxTurns: number;
  readonly signal: AbortSignal;
  readonly messages: readonly ModelMessage[];
  finish(output: string): Promise<void>;
}

const cycleState = Annotation.Root({
  messages: Annotation<ModelMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  turn: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  outcome: Annotation<"continue" | "final" | "budget">({
    reducer: (_left, right) => right,
    default: () => "final",
  }),
});

type CycleState = typeof cycleState.State;

function budgetError(strategy: "ReAct" | "CodeAct", maxTurns: number): Error {
  return new Error(`${strategy} loop exceeded its ${maxTurns}-turn budget`);
}

function assertFinished(
  strategy: "ReAct" | "CodeAct",
  maxTurns: number,
  outcome: CycleState["outcome"],
): void {
  if (outcome === "budget") {
    throw budgetError(strategy, maxTurns);
  }
  if (outcome !== "final") {
    throw new Error(`${strategy} loop stopped before a final answer`);
  }
}

export interface ReactCycle extends CycleHost {
  model(
    turn: number,
    messages: readonly ModelMessage[],
  ): Promise<ModelCycleResult>;
  tool(toolCall: ModelToolCall): Promise<JsonValue>;
}

export async function runReactCycle(cycle: ReactCycle): Promise<void> {
  const graph = new StateGraph(cycleState)
    .addNode("model", async (state) => {
      if (state.turn >= cycle.maxTurns) {
        return { outcome: "budget" as const };
      }
      const completion = await cycle.model(state.turn, state.messages);
      const toolCalls = completion.toolCalls;
      if (toolCalls !== undefined && toolCalls.length > 0) {
        return {
          turn: state.turn + 1,
          outcome: "continue" as const,
          messages: [
            {
              role: "assistant" as const,
              content: completion.content ?? "",
              toolCalls,
            },
          ],
        };
      }
      if (completion.content !== undefined) {
        await cycle.finish(completion.content);
        return {
          turn: state.turn + 1,
          outcome: "final" as const,
        };
      }
      throw new Error("Model returned neither content nor tool calls");
    })
    .addNode("tools", async (state) => {
      const latest = state.messages.at(-1);
      const toolCalls =
        latest?.role === "assistant" ? (latest.toolCalls ?? []) : [];
      const messages: ModelMessage[] = [];
      for (const toolCall of toolCalls) {
        const output = await cycle.tool(toolCall);
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: JSON.stringify(output),
        });
      }
      return { messages };
    })
    .addEdge(START, "model")
    .addConditionalEdges("model", (state) =>
      state.outcome === "continue" ? "tools" : END,
    )
    .addEdge("tools", "model")
    .compile();
  const result = await graph.invoke(
    { messages: [...cycle.messages] },
    cycleConfig(cycle.maxTurns, cycle.signal),
  );
  assertFinished("ReAct", cycle.maxTurns, result.outcome);
}

export function parseCodeFence(
  content: string,
): { language: "javascript" | "python"; source: string } | undefined {
  const match = content.match(
    /```(javascript|js|python|py)[ \t]*\n([\s\S]*?)```/i,
  );
  if (!match) {
    return undefined;
  }
  const tag = match[1]!.toLowerCase();
  return {
    language: tag === "python" || tag === "py" ? "python" : "javascript",
    source: match[2] ?? "",
  };
}

export interface CodeActCycle extends CycleHost {
  model(
    turn: number,
    messages: readonly ModelMessage[],
  ): Promise<ModelCycleResult>;
  sandbox(
    language: "javascript" | "python",
    source: string,
  ): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

export async function runCodeActCycle(cycle: CodeActCycle): Promise<void> {
  const graph = new StateGraph(cycleState)
    .addNode("model", async (state) => {
      if (state.turn >= cycle.maxTurns) {
        return { outcome: "budget" as const };
      }
      const completion = await cycle.model(state.turn, state.messages);
      const content = completion.content ?? "";
      const fence = parseCodeFence(content);
      if (fence) {
        return {
          turn: state.turn + 1,
          outcome: "continue" as const,
          messages: [{ role: "assistant" as const, content }],
        };
      }
      if (completion.content !== undefined) {
        await cycle.finish(completion.content);
        return {
          turn: state.turn + 1,
          outcome: "final" as const,
        };
      }
      throw new Error("Model returned empty CodeAct content");
    })
    .addNode("sandbox", async (state) => {
      const latest = state.messages.at(-1);
      const fence = parseCodeFence(latest?.content ?? "");
      if (!fence) {
        throw new Error("CodeAct sandbox step has no code fence");
      }
      const result = await cycle.sandbox(fence.language, fence.source);
      return {
        messages: [
          {
            role: "user" as const,
            content: `Sandbox exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          },
        ],
      };
    })
    .addEdge(START, "model")
    .addConditionalEdges("model", (state) =>
      state.outcome === "continue" ? "sandbox" : END,
    )
    .addEdge("sandbox", "model")
    .compile();
  const result = await graph.invoke(
    { messages: [...cycle.messages] },
    cycleConfig(cycle.maxTurns, cycle.signal),
  );
  assertFinished("CodeAct", cycle.maxTurns, result.outcome);
}
