import type {
  PromptScanContext,
  PromptScanFinding,
  PromptScanStage,
} from "@borg/plugin-sdk";

export const PROMPT_INJECTION_SCANNER_ID = "borg.security.prompt-injection";

export const PROMPT_INJECTION_STAGES = [
  "user_input",
  "inbound_message",
  "tool_result",
  "model_input",
  "model_output",
  "outbound_message",
] as const satisfies readonly PromptScanStage[];

export const PROMPT_INJECTION_FINDING_CODES = {
  instructionOverride: "injection.instruction-override",
  encodedInstruction: "injection.encoded-instruction",
  systemPromptProbe: "injection.system-prompt-probe",
  secretExfiltration: "injection.exfiltration",
  toolTakeover: "injection.tool-takeover",
} as const;

export type PromptInjectionFindingCode =
  (typeof PROMPT_INJECTION_FINDING_CODES)[keyof typeof PROMPT_INJECTION_FINDING_CODES];

const MAX_FINDINGS = 16;
const MAX_EVIDENCE = 512;
const MAX_REASON = 1_000;
const EVIDENCE_RADIUS = 48;

type FindingAction = PromptScanFinding["action"];

interface PatternRule {
  readonly code: PromptInjectionFindingCode;
  readonly action: Exclude<FindingAction, "allow">;
  readonly reason: string;
  readonly pattern: RegExp;
}

const SEPARATOR = String.raw`[\s._-]{0,20}`;
const SENSITIVE =
  String.raw`(?:system\s+prompt|hidden\s+instructions|developer\s+prompt|hidden\s+prompt|api[\s-]?keys?|secrets?|credentials?)`;
const EXFIL_VERB =
  String.raw`(?:send|post|email|upload|forward|exfiltrate|transmit|leak)`;

const RULES: readonly PatternRule[] = Object.freeze([
  {
    code: PROMPT_INJECTION_FINDING_CODES.instructionOverride,
    action: "review",
    reason: "Text asks the model to ignore or replace its prior instructions",
    pattern: new RegExp(
      String.raw`\b(?:ignore|disregard|forget)\b${SEPARATOR}\b(?:all|any|the|your)?${SEPARATOR}\b(?:previous|prior|above|earlier)\b${SEPARATOR}\b(?:instructions?|rules|prompts?|guidelines)\b`,
      "i",
    ),
  },
  {
    code: PROMPT_INJECTION_FINDING_CODES.instructionOverride,
    action: "review",
    reason: "Text asks the model to act as the system or developer role",
    pattern:
      /\b(?:act\s+as|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as)\s+(?:the\s+|a\s+|an\s+)?(?:system|developer|jailbreak(?:ed)?)\b/i,
  },
  {
    code: PROMPT_INJECTION_FINDING_CODES.instructionOverride,
    action: "review",
    reason: "Text uses a jailbreak or DAN override",
    pattern:
      /\b(?:jailbreak|do\s+anything\s+now|DAN\s+(?:mode|jailbreak)|you\s+are\s+(?:now\s+)?DAN|(?:enable|enter|activate|turn\s+on)\s+developer\s+mode|you\s+are\s+(?:now\s+)?(?:in\s+)?developer\s+mode)\b/i,
  },
  {
    code: PROMPT_INJECTION_FINDING_CODES.encodedInstruction,
    action: "review",
    reason: "Text contains an encoded instruction or system-role marker",
    pattern:
      /(?:<\|im_start\|>\s*system|<<\s*SYS\s*>>|\[INST\]|<\|system\|>|###\s*system(?:\s+prompt)?\s*:|\bSYSTEM\s+OVERRIDE\b)/i,
  },
  {
    code: PROMPT_INJECTION_FINDING_CODES.systemPromptProbe,
    action: "review",
    reason: "Text asks to reveal the system or hidden prompt",
    pattern: new RegExp(
      String.raw`\b(?:reveal|show|print|display|repeat|output|dump)\b[\s\S]{0,40}\b(?:system\s+prompt|hidden\s+instructions|developer\s+prompt|hidden\s+prompt)\b`,
      "i",
    ),
  },
  {
    code: PROMPT_INJECTION_FINDING_CODES.secretExfiltration,
    action: "block",
    reason: "Text tries to exfiltrate a system prompt or secret",
    pattern: new RegExp(
      String.raw`\b${EXFIL_VERB}\b[\s\S]{0,80}\b${SENSITIVE}\b|\b${SENSITIVE}\b[\s\S]{0,80}\b(?:${EXFIL_VERB}|https?:\/\/)\b`,
      "i",
    ),
  },
  {
    code: PROMPT_INJECTION_FINDING_CODES.toolTakeover,
    action: "block",
    reason: "Text tries to take over tools to move secrets or skip approval",
    pattern:
      /\b(?:use\s+tools\s+to\s+(?:exfiltrate|steal|leak)|(?:call|invoke)\b[\s\S]{0,40}\btool\b[\s\S]{0,60}\b(?:send|exfiltrate|post|leak)\b[\s\S]{0,40}\b(?:secret|credential|system\s+prompt|api[\s-]?key)|(?:ignore|bypass|skip)\b[\s\S]{0,20}\b(?:tool\s+)?(?:approval|permission)\b[\s\S]{0,40}\b(?:call|invoke|run|use)\b[\s\S]{0,20}\b(?:tool|function))\b/i,
  },
]);

const ACTION_RANK: Readonly<Record<FindingAction, number>> = Object.freeze({
  block: 0,
  review: 1,
  allow: 2,
});

function boundText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function evidenceOf(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EVIDENCE_RADIUS);
  const end = Math.min(text.length, index + length + EVIDENCE_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return boundText(
    `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`,
    MAX_EVIDENCE,
  );
}

function collectFindings(text: string): PromptScanFinding[] {
  const seen = new Map<PromptInjectionFindingCode, PromptScanFinding>();
  for (const rule of RULES) {
    if (seen.has(rule.code)) {
      continue;
    }
    const match = rule.pattern.exec(text);
    if (!match || match.index === undefined) {
      continue;
    }
    seen.set(
      rule.code,
      Object.freeze({
        code: rule.code,
        action: rule.action,
        reason: boundText(rule.reason, MAX_REASON),
        evidence: evidenceOf(text, match.index, match[0].length),
      }),
    );
    if (seen.size >= MAX_FINDINGS) {
      break;
    }
  }
  return [...seen.values()]
    .sort(
      (left, right) =>
        (ACTION_RANK[left.action] ?? 2) - (ACTION_RANK[right.action] ?? 2),
    )
    .slice(0, MAX_FINDINGS)
    .map((finding) => Object.freeze({ ...finding }));
}

export function scanPromptInjection(
  context: PromptScanContext,
): readonly PromptScanFinding[] {
  context.signal.throwIfAborted();
  const text = typeof context.text === "string" ? context.text : "";
  if (text.length === 0) {
    return [];
  }
  const findings = collectFindings(text);
  context.signal.throwIfAborted();
  return Object.freeze(findings);
}
