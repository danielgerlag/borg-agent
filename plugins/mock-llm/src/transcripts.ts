export interface MockTranscriptFixture {
  readonly id: string;
  readonly prompt: string;
  readonly toolCall?: {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  };
  readonly finalPrefix?: string;
  readonly resultPath?: readonly string[];
  readonly content?: string;
  readonly delayMs?: number;
}

export const mockTranscriptFixtures: readonly MockTranscriptFixture[] =
  Object.freeze([
    {
      id: "tool-approval",
      prompt: "scenario:approval",
      toolCall: {
        id: "mock-echo-call",
        name: "tools.echo",
        input: {
          text: "hello from the approved tool",
        },
      },
      finalPrefix: "Echo completed: ",
      resultPath: ["echoed"],
    },
    {
      id: "ask-user",
      prompt: "scenario:feedback",
      toolCall: {
        id: "mock-feedback-call",
        name: "feedback.ask",
        input: {
          title: "Mock model question",
          prompt: "What should the mock model do next?",
          form: "text",
          source: {},
          timeoutMs: 60_000,
        },
      },
      finalPrefix: "User answered: ",
      resultPath: ["answer", "text"],
    },
    {
      id: "workspace-file",
      prompt: "scenario:file",
      toolCall: {
        id: "mock-file-call",
        name: "filesystem.write",
        input: {
          path: "notes/hello.txt",
          content: "Created by Borg chat.",
        },
      },
      finalPrefix: "File created: ",
      resultPath: ["path"],
    },
    {
      id: "background-turn",
      prompt: "scenario:background",
      content: "Background turn completed while Borg was hidden.",
      delayMs: 1_000,
    },
  ]);
