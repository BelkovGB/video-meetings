/**
 * Reconciles the committed Playwright baselines with the inventory the operator
 * keeps and with the assertions that consume them.
 *
 * A screenshot is only valid in the environment that rendered it, so
 * `apps/web/AGENTS.md` forbids agents from creating or updating snapshots: the
 * validation set runs `playwright test --ignore-snapshots`, and a PNG written by
 * an agent is never compared against anything. That prohibition was broken while
 * it lived only in prose (issue #84), so the tree is reconciled here:
 *
 * - every file under a `*-snapshots/` directory is listed in
 *   `visual-baselines.json`, and every listed name is on disk;
 * - every listed or pending name is produced by a `toHaveScreenshot` call in a
 *   spec, which is what catches baselines orphaned by a renamed spec
 *   (`snapshotPathTemplate` embeds the spec path);
 * - every such call has a baseline or a `pending` entry, so the inventory states
 *   what the operator still owes instead of leaving an assertion that silently
 *   compares against nothing.
 *
 * This does not make the prohibition unbypassable: a session can render a PNG
 * and add the matching line itself. What it buys is that the addition becomes a
 * reviewable line of text beside an opaque binary, and that a fabricated entry
 * has to be paired with a fabricated assertion.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const inventoryFileName = 'visual-baselines.json';

const snapshotDirectorySuffix = '-snapshots';
const specFileSuffix = '.spec.ts';
const screenshotCallPattern = /toHaveScreenshot\(\s*'([^']+)'/g;

type BaselineNames = Record<string, string[]>;

type Inventory = {
  /** Baselines the operator regenerated, keyed by snapshot directory. */
  committed: BaselineNames;
  /** Baselines an assertion asks for and the operator has yet to regenerate. */
  pending: BaselineNames;
};

function readNamesByDirectory(
  source: unknown,
  field: string,
  inventoryPath: string,
): BaselineNames {
  if (source === undefined) {
    return {};
  }
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error(`"${field}" in ${inventoryPath} must be an object.`);
  }

  for (const [directory, names] of Object.entries(source)) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      throw new Error(`"${field}.${directory}" in ${inventoryPath} must be an array of names.`);
    }
  }

  return source as BaselineNames;
}

function readInventory(e2eDir: string): Inventory {
  const inventoryPath = path.join(e2eDir, inventoryFileName);
  const parsed: unknown = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const document = typeof parsed === 'object' && parsed !== null ? parsed : {};

  return {
    committed: readNamesByDirectory(
      (document as { directories?: unknown }).directories,
      'directories',
      inventoryPath,
    ),
    pending: readNamesByDirectory(
      (document as { pending?: unknown }).pending,
      'pending',
      inventoryPath,
    ),
  };
}

/**
 * Every directory under `e2eDir` whose name ends in `-snapshots`, keyed by its
 * path relative to `e2eDir`, mapped to the files directly inside it.
 */
function readSnapshotDirectories(e2eDir: string): BaselineNames {
  const present: BaselineNames = {};

  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(e2eDir, relative), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (!entry.name.endsWith(snapshotDirectorySuffix)) {
        visit(child);
        continue;
      }
      present[child] = readdirSync(path.join(e2eDir, child), { withFileTypes: true })
        .filter((baseline) => baseline.isFile())
        .map((baseline) => baseline.name);
    }
  };

  visit('');
  return present;
}

/**
 * The baselines the specs ask for: each `toHaveScreenshot` argument expanded
 * across the configured projects, keyed by the directory `snapshotPathTemplate`
 * puts them in.
 */
function readAssertedBaselines(e2eDir: string, projectNames: readonly string[]): BaselineNames {
  const asserted: BaselineNames = {};

  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(e2eDir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.endsWith(snapshotDirectorySuffix)) {
          visit(child);
        }
        continue;
      }
      if (!entry.name.endsWith(specFileSuffix)) {
        continue;
      }

      const source = readFileSync(path.join(e2eDir, child), 'utf8');
      const names = [...source.matchAll(screenshotCallPattern)].flatMap(([, argument]) => {
        const extension = path.extname(argument);
        const stem = argument.slice(0, argument.length - extension.length);
        return projectNames.map((project) => `${stem}-${project}${extension}`);
      });

      if (names.length > 0) {
        asserted[`${child}${snapshotDirectorySuffix}`] = names;
      }
    }
  };

  visit('');
  return asserted;
}

type Baseline = { directory: string; name: string };

/** Every name in `source` that none of `known` holds under the same directory. */
function namesMissingFrom(source: BaselineNames, ...known: BaselineNames[]): Baseline[] {
  return Object.entries(source).flatMap(([directory, names]) => {
    const found = new Set(known.flatMap((other) => other[directory] ?? []));
    return names.filter((name) => !found.has(name)).map((name) => ({ directory, name }));
  });
}

/** Every name in `source` that `other` also holds under the same directory. */
function namesSharedWith(source: BaselineNames, other: BaselineNames): Baseline[] {
  return Object.entries(source).flatMap(([directory, names]) => {
    const found = new Set(other[directory] ?? []);
    return names.filter((name) => found.has(name)).map((name) => ({ directory, name }));
  });
}

function report(baselines: Baseline[], explain: (baseline: Baseline) => string): string[] {
  return baselines.map(
    (baseline) => `${baseline.directory}/${baseline.name}: ${explain(baseline)}`,
  );
}

/**
 * One sorted message per baseline that the tree, the inventory and the specs
 * disagree on. `projectNames` are the Playwright project names the snapshot
 * paths are suffixed with.
 */
export function findBaselineViolations(e2eDir: string, projectNames: readonly string[]): string[] {
  const { committed, pending } = readInventory(e2eDir);
  const present = readSnapshotDirectories(e2eDir);
  const asserted = readAssertedBaselines(e2eDir, projectNames);

  return [
    ...report(
      namesMissingFrom(present, committed, pending),
      () =>
        `baseline is not listed in ${inventoryFileName}. Agents do not create Playwright snapshots (apps/web/AGENTS.md); the operator regenerates them with "npm run test:e2e:web:visual" and adds the name to the inventory.`,
    ),
    ...report(
      namesMissingFrom(committed, present),
      () =>
        `listed in ${inventoryFileName}, but the file is missing. Restore the baseline or drop the entry.`,
    ),
    ...report(
      namesSharedWith(pending, present),
      () =>
        `regenerated, but still under "pending" in ${inventoryFileName}. Move the name into "directories".`,
    ),
    ...report(
      [...namesMissingFrom(committed, asserted), ...namesMissingFrom(pending, asserted)],
      ({ directory }) =>
        `no toHaveScreenshot call in ${directory.slice(0, -snapshotDirectorySuffix.length)} produces this name. Drop the entry, or move it beside the spec that renders it.`,
    ),
    ...report(
      namesMissingFrom(asserted, committed, pending, present),
      () =>
        `asserted by a spec with no baseline. Record it under "pending" in ${inventoryFileName} so the operator knows to regenerate it with "npm run test:e2e:web:visual".`,
    ),
  ].sort();
}

/**
 * The baselines a run without `--ignore-snapshots` will write: every name a
 * `toHaveScreenshot` call asks for that is absent from the tree, as
 * `directory/name`.
 *
 * Deliberately read from the specs and the disk rather than from the inventory.
 * `pending` records what the operator was told they owe; whether that matches the
 * tree is the question `findBaselineViolations` exists to settle, so using it to
 * decide when that reconciliation may run would assume its own answer. A stale
 * PNG deleted by hand to force a re-render, or an assertion added without a
 * `pending` entry, is invisible to the inventory and caught here.
 */
export function unrenderedBaselines(e2eDir: string, projectNames: readonly string[]): string[] {
  const present = readSnapshotDirectories(e2eDir);
  const asserted = readAssertedBaselines(e2eDir, projectNames);

  return namesMissingFrom(asserted, present)
    .map(({ directory, name }) => `${directory}/${name}`)
    .sort();
}

/**
 * Whether `findBaselineViolations` can trust the repository tree in this run.
 *
 * `toHaveScreenshot` writes any baseline it does not find unless the run passes
 * `--ignore-snapshots`, and Playwright distributes spec files across workers even
 * under `fullyParallel: false`. So during `npm run test:e2e:web:visual` the guard
 * would read `e2e/` while the specs it reconciles are still writing into it, and
 * the "regenerated, but still pending" message — the operator's cue to move those
 * names into `directories` — would depend on which worker got there first.
 *
 * Two runs leave the tree settled. One passes `--ignore-snapshots`, as the
 * validation set does. The other is a run with nothing absent to write:
 * `unrendered` is empty exactly when every asserted baseline is already on disk,
 * and a baseline is only written when it is missing. That second case is what
 * keeps this guard live for the reader `apps/web/AGENTS.md` sends to
 * `npx playwright test <file>`, which passes no flags — a run that skipped here
 * would report success on the very check that catches an agent-rendered PNG.
 *
 * The specs `unrendered` reads are not rewritten by the concurrent workers, and
 * a worker can only remove a name from it, by creating the file. Every fact this
 * guard checks is a name rather than an image, and the name exists from the
 * moment the file does, so an empty `unrendered` means the names are already
 * final even if bytes are still landing.
 */
export function treeIsStableDuring(
  project: { ignoreSnapshots?: boolean },
  unrendered: readonly string[],
): boolean {
  return project.ignoreSnapshots === true || unrendered.length === 0;
}

/** The baselines the inventory records as still owed, as `directory/name`. */
export function pendingBaselines(e2eDir: string): string[] {
  const { pending } = readInventory(e2eDir);

  return Object.entries(pending)
    .flatMap(([directory, names]) => names.map((name) => `${directory}/${name}`))
    .sort();
}
