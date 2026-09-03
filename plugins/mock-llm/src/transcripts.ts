export interface MockTranscriptFixture {
  readonly id: string;
  readonly prompt: string;
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  };
  readonly finalPrefix: string;
  readonly resultPath: readonly string[];
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
  ]);
