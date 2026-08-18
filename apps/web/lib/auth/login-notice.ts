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
 * The session could no longer authorize the request, so the change was not made
 * under it. Whether the password itself changed is left unsaid: a change commits
 * and revokes the calling session together, so a retry after a lost response is
 * answered `401` with the new password already in force.
 *
 * `POST /users/me/password` answers `401` for a missing, legacy or revoked
 * session, and a token issued before the session migration hits it with a
 * correct current password. Without a reason that sign-out looks exactly like
 * the successful one, minus the notice.
 */
export const sessionRejectedNotice = 'session-rejected';

export const passwordChangedLoginPath = `/login?${loginNoticeParam}=${passwordChangedNotice}`;

export const sessionRejectedLoginPath = `/login?${loginNoticeParam}=${sessionRejectedNotice}`;
