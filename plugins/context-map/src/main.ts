import type { WorkspaceFile } from "@borg-agent/contracts";
import { definePlugin } from "@borg-agent/plugin-sdk";

export const CONTEXT_MAP_SLOT_ID = "borg.context-map.workspace";

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

const ADVANCED_FILE_LIMIT = 20;
const ADVANCED_BYTE_LIMIT = 8_192;

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function isCodeFile(file: WorkspaceFile): boolean {
  return CODE_EXTENSIONS.has(extensionOf(file.path));
}

function textPreview(preview: {
  readonly kind: string;
  readonly path?: string;
  readonly content?: string;
}): string | undefined {
  if (
    preview.kind !== "text" ||
    typeof preview.path !== "string" ||
    typeof preview.content !== "string"
  ) {
    return undefined;
  }
  const content =
    preview.content.length > ADVANCED_BYTE_LIMIT
      ? `${preview.content.slice(0, ADVANCED_BYTE_LIMIT)}\n…`
      : preview.content;
  return `${preview.path}\n${content}`;
}

export default definePlugin({
  id: "borg.context-map",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["prompts.register", "personas.read"],
  contributes: {
    kinds: ["promptSlot"],
  },
  activate(context) {
    return context.prompts.registerSlot({
      id: CONTEXT_MAP_SLOT_ID,
      order: 300,
      async render(slotContext) {
        if (slotContext.workspace === undefined) {
          return undefined;
        }
        const strategy =
          context.personas.get(slotContext.personaId)?.contextMapStrategy ??
          "general";
        const files = await slotContext.workspace.listFiles();
        const selected =
          strategy === "code" ? files.filter(isCodeFile) : files;
        if (selected.length === 0) {
          return undefined;
        }
        const listing = `Workspace files:\n${selected
          .map((file) => file.path)
          .join("\n")}`;
        if (strategy !== "advanced" || slotContext.workspace.readFile === undefined) {
          return listing;
        }
        const readable = selected
          .filter((file) => file.size > 0 && file.size <= ADVANCED_BYTE_LIMIT)
          .slice(0, ADVANCED_FILE_LIMIT);
        const excerpts: string[] = [];
        for (const file of readable) {
          const preview = textPreview(
            await slotContext.workspace.readFile(file.path),
          );
          if (preview) {
            excerpts.push(preview);
          }
        }
        if (excerpts.length === 0) {
          return listing;
        }
        return `${listing}\n\nFile contents:\n${excerpts.join("\n\n")}`;
      },
    });
  },
});
