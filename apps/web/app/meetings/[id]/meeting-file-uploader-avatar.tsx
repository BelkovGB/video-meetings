'use client';

import type { MeetingFile } from '../../../lib/api/contracts';
import {
  formatIdentityInitial,
  formatUploaderAvatarLabel,
} from '../../../lib/format/user-identity';
import { IdentityAvatar } from '../../components/identity-avatar';

type MeetingFileUploaderAvatarProps = {
  meetingId: string;
  file: MeetingFile;
};

/**
 * The uploader's avatar inside meeting activity. The image is read through the
 * meeting file that names the uploader, which is the only route the API
 * authorizes for another user's avatar, so the viewer needs no uploader ID and
 * reaches nothing else of that profile. Every file of one uploader shares the
 * avatar key the API sends, so the image is read once for all of their rows.
 */
export function MeetingFileUploaderAvatar({ meetingId, file }: MeetingFileUploaderAvatarProps) {
  const avatar = file.uploadedBy?.avatar ?? null;

  return (
    <IdentityAvatar
      image={
        avatar
          ? {
              path: `/meetings/${meetingId}/files/${file.id}/uploader-avatar`,
              updatedAt: avatar.updatedAt,
              // The path is per file, so without the uploader's avatar key each
              // row of one uploader would download the same image again.
              sharedKey: avatar.key,
            }
          : null
      }
      accessibleName={formatUploaderAvatarLabel(file.uploadedBy)}
      fallback={formatIdentityInitial(file.uploadedBy?.displayName ?? null)}
      testId="meeting-file-uploader-avatar"
      className="h-6 w-6 text-xs"
    />
  );
}
