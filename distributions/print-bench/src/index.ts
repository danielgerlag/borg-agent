import { defineHarness } from "@borg/harness";

export const printBenchDistribution = defineHarness({
  id: "borg.print-bench",
  name: "Print bench",
  plugins: ["example.print-bench"],
});
