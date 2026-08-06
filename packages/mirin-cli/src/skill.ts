/**
 * `mirin skill` — install the agent skill into an existing project.
 *
 * New apps get it from `mirin init`. This is for the projects that already exist,
 * and for refreshing it after a CLI upgrade: the skill is versioned with the tool it
 * documents, so a stale copy describes a surface that may have moved.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { installSkill } from "create-mirinjs/skill";
import { createReporter } from "./shared/report.ts";

export interface SkillOptions {
  json?: boolean;
}

export async function skill(
  projectDir = process.cwd(),
  options: SkillOptions = {},
): Promise<number> {
  const reporter = createReporter(options.json === true);

  // Not fatal: a monorepo may install the skill at its root rather than beside a
  // manifest. Worth saying, because the usual cause is being in the wrong directory.
  const hasManifest = existsSync(join(projectDir, "mirin.config.ts"));

  try {
    const result = installSkill(projectDir);
    reporter.finish(
      {
        ok: true,
        path: result.path,
        replaced: result.replaced,
        mirinProject: hasManifest,
      },
      () => {
        console.log(
          `\n✓ ${result.replaced ? "updated" : "installed"} the mirin agent skill at ${result.relativePath}`,
        );
        if (!hasManifest) {
          console.log("  ! no mirin.config.ts here — is this the project root?");
        }
        console.log("  it teaches agents to verify changes with `mirin check`.\n");
      },
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.finish({ ok: false, reason: message }, () => {
      console.error(`\n✗ could not install the mirin agent skill: ${message}\n`);
    });
    return 1;
  }
}
