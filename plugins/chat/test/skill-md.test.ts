import { describe, expect, it } from "vitest";
import {
  parseSkillMd,
  skillCatalogId,
  skillNameFromPath,
} from "../src/skill-md";

describe("parseSkillMd", () => {
  it("reads name, description, and body", () => {
    expect(
      parseSkillMd(
        `---
name: pdf
description: Handle PDF files
---

Use pdftotext, then summarize.
`,
      ),
    ).toEqual({
      name: "pdf",
      description: "Handle PDF files",
      body: "Use pdftotext, then summarize.",
    });
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseSkillMd("# PDF\n\nDo the thing.")).toThrow(
      /frontmatter/i,
    );
  });

  it("rejects a missing description", () => {
    expect(() =>
      parseSkillMd(
        `---
name: pdf
---

Body
`,
      ),
    ).toThrow(/description/i);
  });

  it("strips quoted name and description values", () => {
    expect(
      parseSkillMd(
        `---
name: "pdf"
description: 'Handle PDF files'
license: Apache-2.0
---

Quoted body.
`,
      ),
    ).toEqual({
      name: "pdf",
      description: "Handle PDF files",
      body: "Quoted body.",
    });
  });

  it("uses the folder basename when name is missing", () => {
    expect(
      parseSkillMd(
        `---
description: Handle PDF files
---

Body
`,
        skillNameFromPath("skills/pdf"),
      ),
    ).toEqual({
      name: "pdf",
      description: "Handle PDF files",
      body: "Body",
    });
    expect(skillNameFromPath("")).toBe("skill");
  });
});

describe("skillCatalogId", () => {
  it("sanitizes illegal characters in each segment", () => {
    expect(
      skillCatalogId({
        owner: "foo.bar",
        repo: "my repo",
        name: "Skill Name!",
      }),
    ).toBe("github/foo-bar/my-repo/Skill-Name");
  });

  it("skips ids with an empty sanitized segment", () => {
    expect(
      skillCatalogId({
        owner: "...",
        repo: "skills",
        name: "pdf",
      }),
    ).toBeUndefined();
  });
});
