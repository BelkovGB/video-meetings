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
