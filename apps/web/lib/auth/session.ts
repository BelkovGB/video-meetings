/**
 * The only place browser code touches session storage.
 *
 * Storage is `sessionStorage`, never `localStorage`: the session must not
 * outlive the tab.
 *
 * The clearing helpers deliberately come in more than one shape. Callers do not
 * all clear the same keys today, and unifying them would change what a user sees
 * after an expired session on the meeting screens. Each caller keeps its current
 * behaviour and now says which one it uses; converging them is a separate,
 * deliberate change.
 */

const accessTokenKey = 'accessToken';
const userEmailKey = 'userEmail';
const userDisplayNameKey = 'userDisplayName';

export function readAccessToken(): string | null {
  return sessionStorage.getItem(accessTokenKey);
}

export function readUserEmail(): string | null {
  return sessionStorage.getItem(userEmailKey);
}

/** Blank and whitespace-only saved names read back as "no saved name". */
export function readDisplayName(): string | null {
  return sessionStorage.getItem(userDisplayNameKey)?.trim() || null;
}

/**
 * Starts a session after login or registration: store the token, store the
 * email normalized the way the API stores it, and drop any display name left by
 * a previous user of this tab.
 */
export function startSession(accessToken: string, email: string): void {
  sessionStorage.setItem(accessTokenKey, accessToken);
  sessionStorage.setItem(userEmailKey, email.trim().toLowerCase());
  sessionStorage.removeItem(userDisplayNameKey);
}

/**
 * Mirrors the saved display name for the dashboard.
 *
 * The dashboard removes the key when the profile has no name; the profile screen
 * writes an empty string. Reads normalize both to `null`, so the rendered result
 * matches either way. `removeStoredDisplayName` and `writeDisplayName('')` keep
 * both behaviours available rather than silently picking one.
 */
export function writeDisplayName(displayName: string): void {
  sessionStorage.setItem(userDisplayNameKey, displayName);
}

export function removeStoredDisplayName(): void {
  sessionStorage.removeItem(userDisplayNameKey);
}

/** Clears the token, email, and display name. Used by the dashboard and profile. */
export function clearSession(): void {
  sessionStorage.removeItem(accessTokenKey);
  sessionStorage.removeItem(userEmailKey);
  sessionStorage.removeItem(userDisplayNameKey);
}

/** Clears the token and email, leaving the display name. Used by the meeting screens. */
export function clearSessionIdentity(): void {
  sessionStorage.removeItem(accessTokenKey);
  sessionStorage.removeItem(userEmailKey);
}

/** Clears only the token. Used by meeting file download and delete. */
export function clearAccessToken(): void {
  sessionStorage.removeItem(accessTokenKey);
}
