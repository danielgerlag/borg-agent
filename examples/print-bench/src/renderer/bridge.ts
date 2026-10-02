export interface PrintBenchApi {
  command: {
    invoke(id: string, input: unknown): Promise<unknown>;
  };
  interactions: {
    list(): Promise<readonly BenchInteraction[]>;
    respond(id: string, response: BenchAnswer | BenchApproval): Promise<boolean>;
  };
}

export type BenchApproval = {
  readonly kind: "approval";
  readonly decision: "allow" | "deny";
  readonly duration?: "once" | "session" | "always";
};

export type BenchAnswer =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "confirm"; readonly confirmed: boolean }
  | { readonly kind: "choice"; readonly choiceId: string; readonly text?: string };

export interface BenchInteraction {
  readonly id: string;
  readonly kind: "tool_approval" | "classification" | "human_input";
  readonly title: string;
  readonly prompt: string;
  readonly form: "approval" | "text" | "confirm" | "choice";
  readonly choices?: readonly { readonly id: string; readonly label: string }[];
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
