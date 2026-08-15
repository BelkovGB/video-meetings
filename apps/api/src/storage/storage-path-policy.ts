import { isAbsolute, relative } from 'node:path';

/**
 * Containment check shared by the local storage adapters.
 *
 * A resolved path is accepted only when it is strictly below `root`. This is a
 * security boundary: every adapter resolves a caller-influenced name and must
 * refuse anything that escapes its own directory.
 *
 * The two adapters used to carry their own copies of this and they were not
 * identical — the meeting-file copy additionally rejected a relative path
 * starting with `/`. That clause is redundant (`path.relative` never returns a
 * leading separator, and `isAbsolute('/x')` is true on both win32 and posix),
 * but unification keeps the stricter version: a redundant clause on a security
 * check costs nothing, and dropping one would be the only direction that could
 * weaken the boundary.
 */
export function isInsideDirectory(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path !== '' &&
    !path.startsWith('..') &&
    !path.includes('..\\') &&
    !path.startsWith('/') &&
    !isAbsolute(path)
  );
}
