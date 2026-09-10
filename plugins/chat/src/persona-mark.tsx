import type { Persona } from "@borg/contracts";
import { cn } from "@borg/ui-kit";
import type { Component } from "solid-js";

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const PERSONA_COLOR_PRESETS = [
  "#0d9488",
  "#2563eb",
  "#7c3aed",
  "#dc2626",
  "#d97706",
  "#059669",
] as const;

export function personaAccent(
  persona: Pick<Persona, "color">,
): string {
  return persona.color && COLOR_PATTERN.test(persona.color)
    ? persona.color
    : "var(--accent)";
}

export function personaGlyph(
  persona: Pick<Persona, "avatar" | "name">,
): string {
  const avatar = persona.avatar?.trim();
  if (avatar) {
    return avatar;
  }
  return persona.name.slice(0, 1).toUpperCase() || "?";
}

export const PersonaMark: Component<{
  readonly persona: Pick<Persona, "avatar" | "color" | "name">;
  readonly class?: string | undefined;
}> = (props) => (
  <span
    class={cn(
      "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white",
      props.class,
    )}
    style={{ "background-color": personaAccent(props.persona) }}
    aria-hidden="true"
  >
    {personaGlyph(props.persona)}
  </span>
);
