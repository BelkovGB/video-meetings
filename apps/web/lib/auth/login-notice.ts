/**
 * Why the sign-in screen was reached again.
 *
 * The profile screen builds the link and the sign-in screen reads it back, so
 * the parameter and its values live in one place instead of two string literals
 * that can drift apart silently.
 */

export const loginNoticeParam = 'reason';

export const passwordChangedNotice = 'password-changed';

export const passwordChangedLoginPath = `/login?${loginNoticeParam}=${passwordChangedNotice}`;
