/**
 * Why the sign-in screen was reached again.
 *
 * The profile screen builds the link and the sign-in screen reads it back, so
 * the parameter and its values live in one place instead of two string literals
 * that can drift apart silently.
 */

export const loginNoticeParam = 'reason';

export const passwordChangedNotice = 'password-changed';

/**
 * The session could no longer authorize the request. Whether the password itself
 * changed is left unsaid: a change commits and revokes every session of the
 * account together, so a retry after a lost response is answered `401` with the
 * new password already in force.
 *
 * `POST /users/me/password` answers `401` for a missing, legacy or revoked
 * session, and a token issued before the session migration hits it with a
 * correct current password. Without a reason that sign-out looks exactly like
 * the successful one, minus the notice.
 *
 * Every other authenticated `401` takes this notice too. Since a change revokes
 * the whole account, a device that made no request of its own is signed out by
 * one made elsewhere, and the `401` carries no `code` to separate that from an
 * ordinary expiry. The sentence holds for both, and naming the new password is
 * the only way back in: this app has no password reset.
 */
export const sessionRejectedNotice = 'session-rejected';

export const passwordChangedLoginPath = `/login?${loginNoticeParam}=${passwordChangedNotice}`;

export const sessionRejectedLoginPath = `/login?${loginNoticeParam}=${sessionRejectedNotice}`;
