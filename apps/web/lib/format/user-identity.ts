import type { UserIdentity } from '../api/contracts';

/**
 * How shared activity names another user. The two fallbacks describe different
 * facts — a participant who has not set a display name, and a file whose
 * uploading account is gone — and neither may be replaced by an email or any
 * other private profile value.
 */
export function formatUploaderName(uploadedBy: UserIdentity | null): string {
  if (!uploadedBy) {
    return 'участник недоступен';
  }

  return uploadedBy.displayName?.trim() || 'участник без имени';
}

/**
 * The glyph an avatar shows when it has no image: an initial when the user has
 * a display name, and a neutral mark otherwise. It never falls back to an
 * email or any other private value.
 */
export function formatIdentityInitial(displayName: string | null): string {
  const trimmed = displayName?.trim();

  return trimmed ? Array.from(trimmed)[0].toLocaleUpperCase('ru-RU') : '?';
}

/** Names an uploader's avatar with the same identity the file row shows. */
export function formatUploaderAvatarLabel(uploadedBy: UserIdentity | null): string {
  return `Аватар: ${formatUploaderName(uploadedBy)}`;
}
