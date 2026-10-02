export interface PrintBenchApi {
  command: {
    invoke(id: string, input: unknown): Promise<unknown>;
  };
  interactions: {
    list(): Promise<readonly BenchInteraction[]>;
    respond(
      id: string,
      response: {
        kind: "approval";
        decision: "allow" | "deny";
        duration?: "once" | "session" | "always";
      },
    ): Promise<boolean>;
  };
}

export interface BenchInteraction {
  readonly id: string;
  readonly kind: "tool_approval" | "classification" | "human_input";
  readonly title: string;
  readonly prompt: string;
}

declare global {
  interface Window {
    printBench?: PrintBenchApi;
  }
}

export function benchApi(): PrintBenchApi {
  const api = window.printBench;
  if (!api) {
    throw new Error("Print bench bridge is unavailable");
  }
  return api;
}
