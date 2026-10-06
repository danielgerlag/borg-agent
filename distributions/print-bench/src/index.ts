import { defineDistribution } from "@borg-agent/kernel";

export const printBenchDistribution = defineDistribution({
  id: "borg.print-bench",
  name: "Print bench",
  version: "0.1.0",
  kernel: "^0.1.0",
  plugins: [
    "borg.anthropic",
    "borg.azure",
    "borg.config.sqlite",
    "borg.copilot",
    "borg.feedback",
    "borg.mock-llm",
    "borg.ollama",
    "borg.openai",
    "borg.openrouter",
    "borg.secrets.dev",
    "borg.secrets.os",
    "borg.security.prompt-injection",
    "borg.themes",
    "example.print-bench",
  ],
  defaults: {
    models: ["borg.mock-llm:mock:scripted"],
  },
});
