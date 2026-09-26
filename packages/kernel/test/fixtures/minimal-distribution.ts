import { defineDistribution } from "../../src";

export const minimalDistribution = defineDistribution({
  id: "example.minimal",
  name: "Minimal",
  version: "0.1.0",
  kernel: "^0.1.0",
  plugins: [
    "example.config",
    "example.secrets",
    "example.decoy",
    "example.llm",
    { id: "example.optional", enabled: false },
  ],
  defaults: {
    models: ["example.llm:scripted"],
  },
});
