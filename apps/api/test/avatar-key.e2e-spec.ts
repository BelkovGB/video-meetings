import { deriveAvatarKey } from '../src/users/models/avatar-key';

/**
 * The key exists so a client can tell that two responses carry the same avatar
 * and fetch it once. That only holds if every API process agrees on the key, so
 * these tests pin the two properties the client depends on: the key is stable
 * for one avatar in one scope, and it separates users and scopes.
 */
describe('deriveAvatarKey', () => {
  const meetingId = '4b2f5ed1-0d2a-4f39-9f2f-2b3a1c9d0e77';
  const otherMeetingId = 'a1c9d0e7-4b2f-5ed1-0d2a-4f399f2f2b3a';
  const userId = '9f2f2b3a-1c9d-0e77-4b2f-5ed10d2a4f39';
  const otherUserId = '0d2a4f39-9f2f-2b3a-1c9d-0e774b2f5ed1';

  it('gives one avatar in one scope the same key in every process', async () => {
    const first = deriveAvatarKey(meetingId, userId);

    // A second instance behind the load balancer, and the same instance after a
    // restart, both start from the module's initial state.
    jest.resetModules();
    const reloaded = (await import('../src/users/models/avatar-key')) as {
      deriveAvatarKey: typeof deriveAvatarKey;
    };

    expect(reloaded.deriveAvatarKey(meetingId, userId)).toBe(first);
  });

  it('keeps the key opaque, and never repeats it across users or scopes', () => {
    const key = deriveAvatarKey(meetingId, userId);

    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain(userId);
    expect(deriveAvatarKey(meetingId, otherUserId)).not.toBe(key);
    expect(deriveAvatarKey(otherMeetingId, userId)).not.toBe(key);
    // Length-prefixing the scope: concatenation alone would let a longer scope
    // with a shorter user ID collide with a shorter scope and a longer one.
    expect(deriveAvatarKey(`${meetingId}x`, userId)).not.toBe(
      deriveAvatarKey(meetingId, `x${userId}`),
    );
  });
});
