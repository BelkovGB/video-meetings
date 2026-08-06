# Plan: Meeting File Upload and Management

**PRD**: [prd-meeting-file-upload-and-management.md](prd-meeting-file-upload-and-management.md)
**Date**: 2026-08-05

## Implementation Phases

Each phase delivers a usable increment and starts by adding tests for its
behaviour. The first two phases make the API usable independently; the frontend
phases expose the same capabilities in the meeting interface.

## Phase 1: Database and Core Upload API (Tracer Bullet)

**Goal**: Provide the minimal file-storage path: an authorized meeting user can
upload an allowed file and retrieve its metadata through the API.

**Affects**: backend / database

**Tasks**:

- [ ] Write end-to-end tests first for successful upload and listing, rejected
      file types, files over 1 GB, and access outside the meeting.
- [ ] Add a `MeetingFile` record with one meeting association and file metadata
      needed by the list response.
- [ ] Configure the local `upload_dir` and retain each accepted file there.
- [ ] Add JWT-protected upload and list endpoints for the meeting owner and
      participants.
- [ ] Validate the maximum 1 GB size and allowed recording, transcript, and
      document file types before retaining a file.

**Done when**: A valid `POST` stores the file in `upload_dir`, and a `GET`
returns its metadata; invalid files and users outside the meeting are rejected.

## Phase 2: Download and Delete API

**Goal**: Complete the backend file lifecycle so authorized users can download
files and the owner can delete them.

**Affects**: backend

**Tasks**:

- [ ] Write end-to-end tests first for downloading a file, deleting a file, and
      rejecting deletion by a non-owner with `403 Forbidden`.
- [ ] Add a JWT-protected download endpoint for a meeting owner and
      participants.
- [ ] Add a JWT-protected delete endpoint that is available only to the meeting
      owner.
- [ ] Remove the file from storage and its metadata from the list after a
      successful deletion.

**Done when**: An authorized user can download a meeting file, an owner can
delete it, and any non-owner receives `403 Forbidden` when attempting deletion.

## Phase 3: Files Panel (List, Download, and Owner Delete)

**Goal**: Let authorized users find and download meeting files in the interface,
with delete controls visible only to the owner.

**Affects**: frontend

**Tasks**:

- [ ] Write frontend end-to-end tests first for file-list rendering, download
      interaction, and the owner-only delete control.
- [ ] Add a files tab or section to the meeting page.
- [ ] Display attached-file metadata and connect download actions to the API.
- [ ] Show and execute the delete action only for the meeting owner, with clear
      feedback after deletion.
- [ ] Verify the files panel and its interactions on desktop and mobile.

**Done when**: A permitted user can list and download meeting files in the UI,
while the delete action is available and works only for the owner.

## Phase 4: Upload Experience (Drag and Drop and Progress)

**Goal**: Make uploading large files understandable and convenient in the
meeting interface.

**Affects**: frontend

**Tasks**:

- [ ] Write frontend end-to-end tests first for drag-and-drop upload, upload
      progress, unsupported types, and files over 1 GB.
- [ ] Add a drag-and-drop upload area alongside a standard file-selection path.
- [ ] Show upload progress until the server accepts or rejects the file.
- [ ] Present clear client feedback for type and size validation failures.
- [ ] Verify the upload interaction and progress feedback on desktop and mobile.

**Done when**: An authorized user can upload an allowed file through drag and
drop or file selection, sees progress, and receives clear feedback for rejected
files.
