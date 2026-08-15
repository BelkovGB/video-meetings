import { join, resolve, sep } from 'node:path';

import { isInsideDirectory } from '../src/storage/storage-path-policy';

const root = resolve('/srv/video-meetings/uploads');

describe('isInsideDirectory', () => {
  it('accepts a path strictly below the root', () => {
    expect(isInsideDirectory(root, join(root, 'meeting-1'))).toBe(true);
    expect(isInsideDirectory(root, join(root, 'meeting-1', 'content'))).toBe(true);
    expect(isInsideDirectory(root, join(root, 'a', 'b', 'c', 'content.part'))).toBe(true);
  });

  it('rejects the root itself', () => {
    expect(isInsideDirectory(root, root)).toBe(false);
    expect(isInsideDirectory(root, `${root}${sep}`)).toBe(false);
  });

  it('rejects traversal out of the root', () => {
    expect(isInsideDirectory(root, resolve(root, '..'))).toBe(false);
    expect(isInsideDirectory(root, resolve(root, '..', 'other'))).toBe(false);
    expect(isInsideDirectory(root, resolve(root, 'meeting-1', '..', '..', 'etc', 'passwd'))).toBe(
      false,
    );
  });

  it('rejects a sibling directory that shares the root prefix', () => {
    expect(isInsideDirectory(root, `${root}-backup`)).toBe(false);
    expect(isInsideDirectory(root, `${root}-backup${sep}content`)).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isInsideDirectory(root, resolve('/etc/passwd'))).toBe(false);
    expect(isInsideDirectory(root, resolve('/'))).toBe(false);
  });

  it('rejects a traversal expressed with backslashes', () => {
    // On posix `..\\evil` is a single legal file name rather than a traversal,
    // so the check refuses it outright instead of depending on the platform.
    expect(isInsideDirectory(root, join(root, '..\\evil'))).toBe(false);
  });

  it('is not fooled by a target that only textually starts with the root', () => {
    expect(isInsideDirectory('/srv/a', '/srv/ab')).toBe(false);
    expect(isInsideDirectory('/srv/a', '/srv/a/b')).toBe(true);
  });

  it('treats a nested root as containing only its own subtree', () => {
    const temp = join(root, 'temp');
    expect(isInsideDirectory(root, temp)).toBe(true);
    expect(isInsideDirectory(temp, root)).toBe(false);
    expect(isInsideDirectory(temp, join(temp, 'upload.part'))).toBe(true);
  });
});
