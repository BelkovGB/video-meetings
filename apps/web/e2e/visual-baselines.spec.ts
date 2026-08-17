import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findBaselineViolations, inventoryFileName } from './visual-baselines';

const e2eDir = __dirname;

/**
 * A tree shaped like `e2e/`: the inventory plus the baselines actually on disk.
 */
function writeTree(inventory: Record<string, string[]>, present: Record<string, string[]>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'visual-baselines-'));
  writeFileSync(path.join(root, inventoryFileName), JSON.stringify({ directories: inventory }));

  for (const [directory, names] of Object.entries(present)) {
    mkdirSync(path.join(root, directory));
    for (const name of names) {
      writeFileSync(path.join(root, directory, name), '');
    }
  }

  return root;
}

test.describe('committed visual baselines', () => {
  const trees: string[] = [];

  test.afterAll(() => {
    for (const root of trees.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tree(inventory: Record<string, string[]>, present: Record<string, string[]>): string {
    const root = writeTree(inventory, present);
    trees.push(root);
    return root;
  }

  test('every baseline in this repository is one the operator recorded', () => {
    expect(findBaselineViolations(e2eDir)).toEqual([]);
  });

  // The failure this guard exists for: a session adds a visual assertion and
  // writes the PNGs its own browser rendered, which no run ever compares.
  test('reports a baseline the inventory does not list', () => {
    const root = tree(
      { 'profile.spec.ts-snapshots': ['listed-desktop-chromium.png'] },
      {
        'profile.spec.ts-snapshots': ['listed-desktop-chromium.png', 'agent-desktop-chromium.png'],
      },
    );

    expect(findBaselineViolations(root)).toEqual([
      expect.stringContaining('profile.spec.ts-snapshots/agent-desktop-chromium.png'),
    ]);
  });

  test('reports a baseline in a snapshot directory the inventory omits entirely', () => {
    const root = tree({}, { 'files-panel.spec.ts-snapshots': ['agent-desktop-chromium.png'] });

    expect(findBaselineViolations(root)).toEqual([
      expect.stringContaining('files-panel.spec.ts-snapshots/agent-desktop-chromium.png'),
    ]);
  });

  test('reports an inventory entry whose file is gone', () => {
    const root = tree(
      { 'profile.spec.ts-snapshots': ['renamed-desktop-chromium.png'] },
      { 'profile.spec.ts-snapshots': [] },
    );

    expect(findBaselineViolations(root)).toEqual([
      expect.stringContaining('profile.spec.ts-snapshots/renamed-desktop-chromium.png'),
    ]);
  });

  test('ignores directories that hold no baselines', () => {
    const root = tree(
      { 'profile.spec.ts-snapshots': ['listed-desktop-chromium.png'] },
      { 'profile.spec.ts-snapshots': ['listed-desktop-chromium.png'], fixtures: ['avatar.png'] },
    );

    expect(findBaselineViolations(root)).toEqual([]);
  });

  test('rejects an inventory that does not describe directories', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'visual-baselines-'));
    trees.push(root);
    writeFileSync(path.join(root, inventoryFileName), JSON.stringify({ directories: [] }));

    expect(() => findBaselineViolations(root)).toThrow(/must be an object/);
  });
});
