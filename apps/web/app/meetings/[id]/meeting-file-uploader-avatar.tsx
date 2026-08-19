'use client';

import type { MeetingFile } from '../../../lib/api/contracts';
import { formatIdentityInitial } from '../../../lib/format/user-identity';
import { IdentityAvatar } from '../../components/identity-avatar';

type MeetingFileUploaderAvatarProps = {
  meetingId: string;
  file: MeetingFile;
};

/**
 * The uploader's avatar inside meeting activity. The image is read through the
 * meeting-scoped handle the API sends beside the file, which is the only route
 * it authorizes for another user's avatar, so the viewer needs no uploader ID
 * and reaches nothing else of that profile. The handle is the uploader's, not
 * the file's, so every row of one uploader names one URL and the image is read
 * once for all of them.
 */
export function MeetingFileUploaderAvatar({ meetingId, file }: MeetingFileUploaderAvatarProps) {
  const uploader = file.uploadedBy ?? null;
  const avatar = uploader?.avatar ?? null;

  return (
    <IdentityAvatar
      image={
        uploader && avatar
          ? {
              path: `/meetings/${meetingId}/uploaders/${encodeURIComponent(uploader.handle)}/avatar`,
              updatedAt: avatar.updatedAt,
            }
          : null
      }
      // The row names the uploader in the text right beside this avatar, so a
      // labelled image would make every row read that name twice.
      decorative
      fallback={formatIdentityInitial(uploader?.displayName ?? null)}
      testId="meeting-file-uploader-avatar"
      className="h-6 w-6 text-xs"
    />
  );
}
