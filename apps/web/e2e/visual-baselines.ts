/**
 * Reconciles the committed Playwright baselines with the inventory the operator
 * keeps.
 *
 * A screenshot is only valid in the environment that rendered it, so
 * `apps/web/AGENTS.md` forbids agents from creating or updating snapshots: the
 * validation set runs `playwright test --ignore-snapshots`, and a PNG written by
 * an agent is never compared against anything. The prohibition was already
 * broken in prose (issue #84), so it is checked here instead: every file under a
 * `*-snapshots/` directory must be listed in `visual-baselines.json`, and the
 * operator adds names there when regenerating with `npm run test:e2e:web:visual`.
 *
 * The same list catches an orphaned baseline. `snapshotPathTemplate` embeds the
 * spec path, so renaming a spec leaves a PNG behind that nothing compares again.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const inventoryFileName = 'visual-baselines.json';

const snapshotDirectorySuffix = '-snapshots';

function readInventory(e2eDir: string): Record<string, string[]> {
  const inventoryPath = path.join(e2eDir, inventoryFileName);
  const parsed: unknown = JSON.parse(readFileSync(inventoryPath, 'utf8'));

  const directories =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { directories?: unknown }).directories
      : undefined;
  if (typeof directories !== 'object' || directories === null || Array.isArray(directories)) {
    throw new Error(`"directories" in ${inventoryPath} must be an object.`);
  }

  for (const [directory, names] of Object.entries(directories)) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      throw new Error(`"directories.${directory}" in ${inventoryPath} must be an array of names.`);
    }
  }

  return directories as Record<string, string[]>;
}

function readSnapshotDirectories(e2eDir: string): Record<string, string[]> {
  const present: Record<string, string[]> = {};

  for (const entry of readdirSync(e2eDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(snapshotDirectorySuffix)) {
      continue;
    }
    present[entry.name] = readdirSync(path.join(e2eDir, entry.name));
  }

  return present;
}

/**
 * One sorted message per baseline that the inventory and the tree disagree on.
 */
export function findBaselineViolations(e2eDir: string): string[] {
  const inventory = readInventory(e2eDir);
  const present = readSnapshotDirectories(e2eDir);
  const violations: string[] = [];

  for (const [directory, names] of Object.entries(present)) {
    const listed = new Set(inventory[directory] ?? []);
    for (const name of names.filter((name) => !listed.has(name))) {
      violations.push(
        `${directory}/${name}: baseline is not listed in ${inventoryFileName}. Agents do not create Playwright snapshots (apps/web/AGENTS.md); the operator regenerates them with "npm run test:e2e:web:visual" and adds the name to the inventory.`,
      );
    }
  }

  for (const [directory, names] of Object.entries(inventory)) {
    const found = new Set(present[directory] ?? []);
    for (const name of names.filter((name) => !found.has(name))) {
      violations.push(
        `${directory}/${name}: listed in ${inventoryFileName}, but the file is missing. Restore the baseline or drop the entry.`,
      );
    }
  }

  return violations.sort();
}
