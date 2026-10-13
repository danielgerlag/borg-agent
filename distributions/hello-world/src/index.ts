import { defineHarness } from "@borg/harness";

export const helloWorldDistribution = defineHarness({
  id: "borg.hello-world",
  name: "Hello world",
  plugins: ["example.hello-world"],
});
