import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scaffold } from "../src/scaffold.ts";
import { installSkill } from "../src/skill.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", ".mirin-test");
const dirs: string[] = [];

function tempDir(): string {
  const dir = join(ROOT, crypto.randomUUID());
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(async () => {
  for (const dir of dirs) await Bun.$`rm -rf ${dir}`.quiet();
});

const SKILL_FILES = ["SKILL.md", "reference/inspector.md", "reference/scenarios.md"];

describe("agent skill install", () => {
  test("writes the skill where Claude Code looks for it", () => {
    const dir = tempDir();
    const result = installSkill(dir);

    expect(result.relativePath).toBe(join(".claude", "skills", "mirin"));
    expect(result.replaced).toBe(false);
    for (const file of SKILL_FILES) {
      expect(existsSync(join(dir, ".claude", "skills", "mirin", file))).toBe(true);
    }
  });

  // The frontmatter is what makes a skill discoverable at all — a skill whose
  // description never matches is a skill that never runs.
  test("SKILL.md carries name and description frontmatter", () => {
    const dir = tempDir();
    const text = readFileSync(join(installSkill(dir).path, "SKILL.md"), "utf8");

    expect(text.startsWith("---\n")).toBe(true);
    const frontmatter = text.slice(4, text.indexOf("\n---", 4));
    expect(frontmatter).toContain("name: mirin");
    expect(frontmatter).toMatch(/description: \S/);
    // The description carries the triggers, so it has to be substantial.
    expect(frontmatter.length).toBeGreaterThan(120);
  });

  // A stale reference file left from an older version reads as current, which is
  // worse than not shipping one at all.
  test("a reinstall replaces the tree instead of merging into it", () => {
    const dir = tempDir();
    installSkill(dir);
    const stale = join(dir, ".claude", "skills", "mirin", "reference", "gone.md");
    writeFileSync(stale, "from an older version");

    const result = installSkill(dir);

    expect(result.replaced).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(result.path, "SKILL.md"))).toBe(true);
  });

  test("leaves other skills in the project alone", () => {
    const dir = tempDir();
    const other = join(dir, ".claude", "skills", "team-conventions");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "ours");

    installSkill(dir);

    expect(readFileSync(join(other, "SKILL.md"), "utf8")).toBe("ours");
  });

  test("a scaffolded app ships with it", () => {
    const dir = join(tempDir(), "app");
    scaffold(dir, { name: "demo-app" });

    for (const file of SKILL_FILES) {
      expect(existsSync(join(dir, ".claude", "skills", "mirin", file))).toBe(true);
    }
    // Not gitignored: the skill is shared with whoever clones the project.
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).not.toContain(".claude");
  });

  test("the skill is not run through the template's placeholder pass", () => {
    const dir = join(tempDir(), "app");
    scaffold(dir, { name: "demo-app" });

    const text = readFileSync(join(dir, ".claude", "skills", "mirin", "SKILL.md"), "utf8");
    expect(text).not.toContain("demo-app");
    expect(text).not.toContain("__APP_NAME__");
  });
});
