import { definePlugin } from "@borg/plugin-sdk";
import {
  PROMPT_INJECTION_SCANNER_ID,
  PROMPT_INJECTION_STAGES,
  scanPromptInjection,
} from "./scanner";

export {
  PROMPT_INJECTION_FINDING_CODES,
  PROMPT_INJECTION_SCANNER_ID,
  PROMPT_INJECTION_STAGES,
  scanPromptInjection,
} from "./scanner";
export type { PromptInjectionFindingCode } from "./scanner";

export default definePlugin({
  id: "borg.security.prompt-injection",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["scanners.register"],
  contributes: {
    kinds: ["promptScanner"],
  },
  activate(context) {
    return context.scanners.register({
      id: PROMPT_INJECTION_SCANNER_ID,
      stages: PROMPT_INJECTION_STAGES,
      scan: async (scanContext) => scanPromptInjection(scanContext),
    });
  },
});
