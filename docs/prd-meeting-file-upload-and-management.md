# PRD: Meeting File Upload and Management

**Date**: 2026-08-04
**Status**: Draft

## Goal

Allow meeting owners and participants to attach meeting recordings, transcripts,
and documents so that all permitted attendees can access the meeting materials
in one place.

## User Scenarios

- A meeting owner or participant uploads an audio or video recording,
  transcript, or document up to 1 GB and sees it in that meeting's files
  section.
- A meeting owner or participant opens a meeting, sees the attached files with
  their names, types, sizes, and upload dates, and downloads a selected file.
- A meeting owner deletes a file from the meeting and no longer sees it in the
  files section.
- A meeting participant cannot delete a file from the meeting.
- A user who is not the meeting owner or a participant cannot upload, view,
  download, or delete that meeting's files.

## Out of Scope

- Automatic transcription, transcription editing, media playback, previews, or
  content extraction.
- File versioning, recovery after deletion, sharing a file outside its meeting,
  and public links.
- File categories beyond audio recordings, video recordings, transcripts, and
  documents.
- Uploads larger than 1 GB.

## Technical Constraints

- A single uploaded file must not exceed 1 GB.
- A file belongs to exactly one meeting.
- Only the meeting owner and its participants may upload, view, or download
  that meeting's files.
- Only the meeting owner may delete a file. A delete attempt by another user
  returns `403 Forbidden`.
- The files interface must work on desktop and mobile screens.
- This iteration stores files only; it does not process their contents.

## Definition of Done

- [ ] A meeting owner and participant can upload an audio recording, video
      recording, transcript, or document no larger than 1 GB to their meeting.
- [ ] The meeting screen shows all files attached to the current meeting with
      file name, type, size, and upload date.
- [ ] A meeting owner and participant can download each file displayed for their
      meeting.
- [ ] A meeting owner can delete a file from their meeting, and the deleted file
      is no longer available for download or shown in the meeting.
- [ ] A meeting participant cannot delete a file and receives `403 Forbidden`.
- [ ] A user outside the meeting cannot upload, view, download, or delete its
      files.
- [ ] Files larger than 1 GB and unsupported file types are rejected with a
      clear error message.
- [ ] The upload and file-list interfaces are usable on desktop and mobile.
