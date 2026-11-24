// FILE: src/lib/managed-skills.grammar.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Enforce the canonical six-block grammar for every managed skill template and the reference-file contract around it.
//   SCOPE: Frontmatter identity, top-level block allowlist and order, required blocks, attribute policy, nested step and rule placement, reference existence and one-level depth, and contents coverage for long hand-authored markdown references.
//   DEPENDS: [bun:test, node:fs/promises, src/lib/managed-skills.ts]
//   LINKS: M-CLI-MANAGED-SKILLS, V-M-CLI-MANAGED-SKILLS
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BLOCKS - Canonical top-level block names in required order.
//   REQUIRED_BLOCKS - Blocks every skill must declare.
//   ALLOWED_ELEMENTS - Block names plus the two addressable nested elements.
//   VALID_SKILL - Positive synthetic skill fixture.
//   frontmatterOf - Split a skill document into frontmatter and body.
//   assertSkillGrammar - Validate one skill document against the canonical grammar.
//   ReferenceFixture - Injectable reference-directory data for contract validation.
//   REFERENCE_TEMPLATE - Minimal refs block used by reference-contract fixtures.
//   referenceFixture - Build a reference-contract fixture with overrides.
//   contentsNearTop - Check that a markdown reference declares its contents near the title.
//   assertReferenceContract - Validate files, directories, refs, and contents from injected data.
//   assertReferenceSet - Validate the reference directory contract for one shipped skill.
//   stripCdata - Remove nested CDATA regions before tag scanning.
//   stripFences - Remove fenced code blocks before tag scanning.
//   stripInlineCode - Remove inline code spans before tag scanning.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-MANAGED-SKILLS-CANONICAL-GRAMMAR - Added the deterministic grammar and reference gate for all managed skills.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  MANAGED_SKILL_NAMES,
  type ManagedSkillName,
  loadManagedSkillReference,
  loadManagedSkillTemplate,
} from "./managed-skills.js";

const BLOCKS = ["scope", "workflow", "rules", "artifact", "refs", "done"] as const;
const REQUIRED_BLOCKS = ["scope", "workflow", "rules", "done"] as const;
const ALLOWED_ELEMENTS = new Set<string>([...BLOCKS, "step", "rule"]);

function stripCdata(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<![CDATA[", index);
    if (start === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, start);
    let depth = 1;
    let cursor = start + "<![CDATA[".length;
    while (cursor < text.length && depth > 0) {
      const nextOpen = text.indexOf("<![CDATA[", cursor);
      const nextClose = text.indexOf("]]>", cursor);
      if (nextClose === -1) {
        throw new Error("unterminated CDATA section");
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen + "<![CDATA[".length;
      } else {
        depth -= 1;
        cursor = nextClose + 3;
      }
    }
    index = cursor;
  }
  return output;
}

function stripFences(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n");
}

function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, "");
}

function frontmatterOf(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith("---\n")) throw new Error("missing YAML frontmatter");
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error("unterminated YAML frontmatter");
  return {
    frontmatter: text.slice(4, end),
    body: text.slice(end + 5),
  };
}

/**
 * Validate one skill document against the canonical six-block grammar.
 * Throws on the first structural violation.
 */
export function assertSkillGrammar(text: string, expectedName: string): void {
  const { frontmatter, body } = frontmatterOf(text);

  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  if (name !== expectedName) {
    throw new Error(`frontmatter name ${JSON.stringify(name)} does not match ${expectedName}`);
  }
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!description) throw new Error("empty description");
  if (description.length > 1024) throw new Error("description exceeds 1024 characters");

  const cleaned = stripInlineCode(stripFences(stripCdata(body)));
  const tokenPattern = /<\/?([A-Za-z][A-Za-z0-9_-]*)(\s+[^<>]*?)?>/g;
  const stack: string[] = [];
  const blocks: string[] = [];

  for (const match of cleaned.matchAll(tokenPattern)) {
    const raw = match[0];
    const element = match[1];
    const attributes = match[2] ?? "";

    if (raw.startsWith("</")) {
      const opened = stack.pop();
      if (opened !== element) {
        throw new Error(`mismatched closing element </${element}>; open element is ${opened}`);
      }
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(element)) {
      throw new Error(`disallowed element <${element}>`);
    }
    const isBlock = (BLOCKS as readonly string[]).includes(element);
    if (isBlock && stack.length > 0) {
      throw new Error(`top-level block <${element}> must not be nested`);
    }
    if ((element === "step" || element === "rule") && stack[stack.length - 1] === element) {
      throw new Error(`<${element}> must not nest inside another <${element}>`);
    }
    if (element === "step" && !stack.includes("workflow")) {
      throw new Error("<step> is only valid inside <workflow>");
    }
    if (element === "rule" && !stack.includes("rules")) {
      throw new Error("<rule> is only valid inside <rules>");
    }

    const attributeNames = [...attributes.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=/g)].map(
      (attribute) => attribute[1],
    );
    const allowedAttributes = element === "step" ? ["name"] : element === "rule" ? ["id"] : [];
    for (const attributeName of attributeNames) {
      if (!allowedAttributes.includes(attributeName)) {
        throw new Error(`attribute ${attributeName} is not allowed on <${element}>`);
      }
    }

    if (isBlock) blocks.push(element);
    stack.push(element);
  }

  if (stack.length > 0) throw new Error(`unclosed element <${stack[stack.length - 1]}>`);

  const uniqueBlocks = new Set(blocks);
  if (uniqueBlocks.size !== blocks.length) throw new Error("duplicate top-level block");
  for (const required of REQUIRED_BLOCKS) {
    if (!uniqueBlocks.has(required)) throw new Error(`missing required block <${required}>`);
  }
  const canonicalOrder = BLOCKS.filter((block) => uniqueBlocks.has(block));
  if (blocks.join(",") !== canonicalOrder.join(",")) {
    throw new Error(`top-level blocks out of order: ${blocks.join(", ")}`);
  }
}

export type ReferenceFixture = {
  name: string;
  template: string;
  files: string[];
  directories: string[];
  readReference: (file: string) => Promise<string> | string;
};

function contentsNearTop(content: string): boolean {
  return content
    .split("\n")
    .slice(0, 15)
    .some((line) => line.trim() === "## Contents");
}

/**
 * Validate a reference contract from injected data so every rejection path
 * can be exercised by a synthetic fixture.
 */
export async function assertReferenceContract(fixture: ReferenceFixture): Promise<void> {
  if (fixture.directories.length > 0) {
    throw new Error(`nested reference directory in ${fixture.name}: ${fixture.directories[0]}`);
  }

  const refsText = fixture.template.match(/<refs>([\s\S]*?)<\/refs>/)?.[1] ?? "";
  const referenced = [...refsText.matchAll(/references\/([^\s`]+)/g)].map((match) => match[1]);

  for (const reference of referenced) {
    if (!fixture.files.includes(reference)) {
      throw new Error(`${fixture.name} refs names a missing file: references/${reference}`);
    }
  }
  for (const file of fixture.files) {
    if (!referenced.includes(file)) {
      throw new Error(`${fixture.name} ships an unlisted reference: references/${file}`);
    }
  }

  for (const file of fixture.files) {
    if (!file.endsWith(".md") || file === "tool-contracts.md") continue;
    const content = await fixture.readReference(file);
    const lineCount = content.replace(/\n$/, "").split("\n").length;
    if (lineCount > 100 && !contentsNearTop(content)) {
      throw new Error(
        `${fixture.name}/references/${file} has ${lineCount} lines and no contents section`,
      );
    }
  }
}

/**
 * Validate the reference contract for one shipped skill.
 */
export async function assertReferenceSet(name: ManagedSkillName): Promise<void> {
  const referenceDir = new URL(`../../templates/skills/${name}/references/`, import.meta.url);
  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(referenceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await assertReferenceContract({
    name,
    template: await loadManagedSkillTemplate(name),
    files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    readReference: (file) => loadManagedSkillReference(name, file),
  });
}

const VALID_SKILL = `---
name: sample
description: Sample skill.
---

<scope>
Sample scope.
</scope>

<workflow>
1. Sample step.
</workflow>

<rules>
- Sample rule.
</rules>

<artifact>
| Mode | Owner |
|---|---|
| inline | session |
</artifact>

<refs>
- \`references/sample.md\` — load when needed.
</refs>

<done>
Sample done.
</done>
`;

const REFERENCE_TEMPLATE = `<refs>
- \`references/a.md\` — load when needed.
</refs>`;

function referenceFixture(overrides: Partial<ReferenceFixture> = {}): ReferenceFixture {
  return {
    name: "sample",
    template: REFERENCE_TEMPLATE,
    files: ["a.md"],
    directories: [],
    readReference: () => "# A\n\nShort reference.\n",
    ...overrides,
  };
}

describe("managed skill grammar", () => {
  test("every shipped template conforms to the canonical six-block grammar", async () => {
    for (const name of MANAGED_SKILL_NAMES) {
      const template = await loadManagedSkillTemplate(name);
      expect(() => assertSkillGrammar(template, name)).not.toThrow();
    }
  });

  test("every shipped reference set is one level deep, declared, and contents-covered", async () => {
    for (const name of MANAGED_SKILL_NAMES) {
      await expect(assertReferenceSet(name)).resolves.toBeUndefined();
    }
  });

  test("accepts a valid synthetic document", () => {
    expect(() => assertSkillGrammar(VALID_SKILL, "sample")).not.toThrow();
  });

  test("rejects a banned identity block", () => {
    const text = VALID_SKILL.replace("<scope>", "<identity>identity</identity>\n<scope>");
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/disallowed element <identity>/);
  });

  test("rejects a kebab-case top-level element", () => {
    const text = VALID_SKILL.replace("<scope>", "<when-to-use>scope</when-to-use>\n<scope>");
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/disallowed element <when-to-use>/);
  });

  test("rejects an uppercase element that hides an old envelope", () => {
    const text = VALID_SKILL.replace("Sample scope.", "Sample scope.\n<Identity>x</Identity>");
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/disallowed element <Identity>/);
  });

  test("rejects out-of-order blocks", () => {
    const text = `---
name: sample
description: Sample.
---

<scope>s</scope>
<rules>- r.</rules>
<workflow>1. w.</workflow>
<done>d.</done>
`;
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/out of order/);
  });

  test("rejects a duplicate top-level block", () => {
    const text = VALID_SKILL.replace("</rules>", "</rules>\n<rules>\n- again.\n</rules>");
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/duplicate top-level block/);
  });

  test("rejects a nested top-level block", () => {
    const text = VALID_SKILL.replace(
      "- Sample rule.",
      "- Sample rule.\n<artifact>nested</artifact>",
    );
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/must not be nested/);
  });

  test("rejects a missing done block", () => {
    const text = VALID_SKILL.replace(/<done>[\s\S]*?<\/done>\n/, "");
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/missing required block <done>/);
  });

  test("rejects an unapproved attribute", () => {
    const text = VALID_SKILL.replace("<scope>", '<scope kind="x">');
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/attribute kind is not allowed/);
  });

  test("rejects a step outside workflow", () => {
    const text = VALID_SKILL.replace("<rules>", '<step name="x">step</step>\n<rules>');
    expect(() => assertSkillGrammar(text, "sample")).toThrow(
      /<step> is only valid inside <workflow>/,
    );
  });

  test("rejects a rule outside rules", () => {
    const text = VALID_SKILL.replace("<scope>", '<rule id="x">rule</rule>\n<scope>');
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/<rule> is only valid inside <rules>/);
  });

  test("rejects nested rule elements", () => {
    const text = VALID_SKILL.replace(
      "- Sample rule.",
      '<rule id="outer"><rule id="inner">nested</rule></rule>',
    );
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/must not nest/);
  });

  test("rejects an unclosed element", () => {
    const text = VALID_SKILL.replace("</done>", "");
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/unclosed element <done>/);
  });

  test("rejects an unterminated CDATA section", () => {
    const text = VALID_SKILL.replace("Sample scope.", "Sample scope.\n<![CDATA[oops");
    expect(() => assertSkillGrammar(text, "sample")).toThrow(/unterminated CDATA/);
  });

  test("allows name on step and id on rule", () => {
    const text = VALID_SKILL.replace(
      "<workflow>\n1. Sample step.",
      '<workflow>\n<step name="sample">1. Sample step.</step>',
    ).replace("<rules>\n- Sample rule.", '<rules>\n<rule id="sample">- Sample rule.</rule>');
    expect(() => assertSkillGrammar(text, "sample")).not.toThrow();
  });

  test("ignores tags inside CDATA, fenced code, and inline code", () => {
    const text = VALID_SKILL.replace(
      "Sample scope.",
      "Sample scope.\n<![CDATA[<identity>fake</identity>]]>\n```xml\n<identity>fake</identity>\n```\n`<identity>` stays text.",
    );
    expect(() => assertSkillGrammar(text, "sample")).not.toThrow();
  });

  test("rejects a frontmatter name that disagrees with the directory", () => {
    expect(() => assertSkillGrammar(VALID_SKILL, "other")).toThrow(/does not match/);
  });
});

describe("managed skill reference contract", () => {
  test("accepts a valid reference set", async () => {
    await expect(assertReferenceContract(referenceFixture())).resolves.toBeUndefined();
  });

  test("rejects a referenced file that does not exist", async () => {
    await expect(assertReferenceContract(referenceFixture({ files: [] }))).rejects.toThrow(
      /missing file/,
    );
  });

  test("rejects a shipped file that refs does not list", async () => {
    await expect(
      assertReferenceContract(referenceFixture({ files: ["a.md", "extra.md"] })),
    ).rejects.toThrow(/unlisted reference/);
  });

  test("rejects a nested reference directory", async () => {
    await expect(
      assertReferenceContract(referenceFixture({ directories: ["nested"] })),
    ).rejects.toThrow(/nested reference directory/);
  });

  test("rejects a long markdown reference without a contents section", async () => {
    const long = `${Array.from({ length: 101 }, () => "line").join("\n")}\n`;
    await expect(
      assertReferenceContract(referenceFixture({ readReference: () => long })),
    ).rejects.toThrow(/no contents section/);
  });

  test("rejects a contents section that is not near the title", async () => {
    const long = `${Array.from({ length: 101 }, () => "line").join("\n")}\n## Contents\n`;
    await expect(
      assertReferenceContract(referenceFixture({ readReference: () => long })),
    ).rejects.toThrow(/no contents section/);
  });

  test("accepts a long markdown reference with a leading contents section", async () => {
    const long = `# A\n\n## Contents\n- One\n\n${Array.from({ length: 101 }, () => "line").join(
      "\n",
    )}\n`;
    await expect(
      assertReferenceContract(referenceFixture({ readReference: () => long })),
    ).resolves.toBeUndefined();
  });

  test("exempts the generated tool-contracts reference from the contents rule", async () => {
    const long = `${Array.from({ length: 101 }, () => "line").join("\n")}\n`;
    await expect(
      assertReferenceContract(
        referenceFixture({
          template: "<refs>\n- `references/tool-contracts.md` — generated.\n</refs>",
          files: ["tool-contracts.md"],
          readReference: () => long,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
