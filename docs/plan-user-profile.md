# Plan: User Profile

**PRD**: [prd-user-profile.md](prd-user-profile.md)
**Date**: 2026-08-12

## Implementation Phases

The plan delivers the profile in independently usable backend and frontend
increments. It starts with the smallest protected profile path, then adds avatar
management, identity in shared activity, and password change without expanding
into email changes, account lifecycle, or multi-device session management.

## Phase 1: Core Profile API (Tracer Bullet)

**Goal**: Let an authenticated user retrieve their safe account details and save
a display name through the API.

**Affects**: backend / database

**Tasks**:

- [ ] Implement the core current-user profile API as one complete TDD slice: add
      end-to-end coverage; persist an optional display name for existing and new
      users without changing registration; expose JWT-protected read and update
      operations that return only safe profile fields and keep email read-only;
      trim names and enforce the 1–100 Unicode-character rule without
      overwriting a saved value when validation fails.
- [ ] Document the profile operations and the resulting Users/Auth module
      boundaries in the API documentation.

**Done when**: An authenticated API client can read only its own safe profile and
save a valid display name, while invalid names and unauthorized requests leave
profile data unchanged.

## Phase 2: Profile Screen and Display Name

**Goal**: Give the user a usable profile screen for viewing account information
and updating their display name.

**Affects**: frontend

**Tasks**:

- [ ] Add Playwright coverage for opening the protected profile screen, the
      read-only email, successful name updates, invalid names, and expired or
      missing authentication.
- [ ] Add a profile entry point and screen that loads the current display name
      and email from the profile API.
- [ ] Add the display-name form with field-level validation, pending, success,
      and server-error states while keeping email non-editable.
- [ ] Replace email-based self-identification in existing account entry points
      with the saved display name where available.
- [ ] Use the project UI/UX workflow and verify keyboard, assistive-technology,
      desktop, and mobile behaviour through Playwright.

**Done when**: A signed-in user can open the profile, see a read-only email, save
a valid display name, and immediately see that name at existing self-identity
entry points.

## Phase 3: Avatar Management API

**Goal**: Let the current user safely upload, retrieve, replace, and remove their
avatar through authenticated API operations.

**Affects**: backend / database

**Tasks**:

- [ ] Add API and storage tests for valid upload, retrieval, replacement,
      removal, unsupported or malformed content, the 5 MB limit, failed
      replacement, and unauthorized access.
- [ ] Add avatar metadata to the user profile and private avatar-storage
      configuration without mixing avatar ownership with meeting-file records.
- [ ] Add protected current-user avatar upload, retrieval, and removal
      operations that never accept a target user ID from the caller.
- [ ] Accept one verified JPEG, PNG, or WebP image up to 5 MB and preserve the
      previous avatar unless its replacement completes successfully.
- [ ] Remove superseded avatar content and document avatar operations, limits,
      storage configuration, and failure behaviour.

**Done when**: An authenticated API client can manage only its own valid avatar;
invalid uploads keep the existing image, and removal leaves the account intact.

## Phase 4: Avatar Controls and Account Identity

**Goal**: Let users manage their avatar in the profile and see it or its fallback
at existing account entry points.

**Affects**: frontend

**Tasks**:

- [ ] Add Playwright coverage for selecting, uploading, replacing, and removing
      an avatar; invalid format and size errors; and fallback rendering.
- [ ] Add avatar upload and removal controls to the profile with previews,
      pending states, and clear field-level failures.
- [ ] Add a reusable identity avatar that uses the current image or a neutral
      display-name fallback without making the image itself the only label.
- [ ] Show the reusable avatar at existing account entry points and refresh all
      visible instances after replacement or removal.
- [ ] Use the project UI/UX workflow and visually verify keyboard, alternative
      text, desktop, and mobile behaviour through Playwright.

**Done when**: A user can manage the avatar from the profile and every visible
self-identity entry point shows the current avatar or an accessible neutral
fallback.

## Phase 5: User Identity in Shared Activity API

**Goal**: Attach the current user identity to existing activity that authorized
meeting participants can see, without exposing private profile data.

**Affects**: backend

**Tasks**:

- [ ] Add API end-to-end tests for actor identity on visible meeting activity,
      avatar replacement and removal, fallback data, and denial outside the
      shared meeting context.
- [ ] Include only the actor's display name and avatar reference with existing
      user-attributed meeting activity, excluding email and other private
      profile data.
- [ ] Authorize shared avatar retrieval with the same meeting-access rule as
      the activity in which the avatar appears.
- [ ] Resolve the actor's current display name and avatar so later profile
      changes appear without rewriting historical activity.
- [ ] Document the shared actor representation and its access rules in the API
      documentation.

**Done when**: An owner or participant receives the current safe actor identity
with accessible meeting activity, while a user outside that meeting cannot use
the activity or avatar reference to retrieve it.

## Phase 6: User Identity in Shared Activity UI

**Goal**: Help meeting participants recognize who performed visible activity by
showing the actor's current avatar or fallback.

**Affects**: frontend

**Tasks**:

- [ ] Add Playwright coverage for actor identity on visible meeting activity,
      avatar and fallback rendering, and refreshed identity after profile
      changes.
- [ ] Render the actor's display name and reusable avatar alongside existing
      user-attributed activity in shared meeting views.
- [ ] Load shared avatars only through the authorized activity context and fall
      back safely when an image is absent or unavailable.
- [ ] Ensure activity remains understandable when the image cannot be seen and
      that actor identity does not reveal email or link to a private profile.
- [ ] Use the project UI/UX workflow and visually verify shared activity at
      desktop and mobile sizes through Playwright.

**Done when**: Every existing user-attributed activity visible to meeting
participants identifies its actor with the current avatar or neutral fallback,
without exposing private profile access.

## Phase 7: Password Change and Current-Session Revocation API

**Goal**: Let an authenticated user change their password using the old password
and make the session that performed the change unusable after success.

**Affects**: backend / database

**Tasks**:

- [ ] Add end-to-end tests for the correct and incorrect old password, reused or
      invalid new passwords, mismatched confirmation, successful old/new login,
      current-token revocation, and an unaffected session on another device.
- [ ] Add a protected password-change operation requiring the old password, new
      password, and matching confirmation, using the registration password
      limits.
- [ ] Verify the old password, reject reuse, and replace the password hash only
      after all validation succeeds without returning or logging credentials.
- [ ] Give issued JWTs a session identity and revoke only the session used for a
      successful password change so the guard rejects that token afterward.
- [ ] Document password-change responses, current-session revocation, and the
      unchanged status of sessions on other devices.

**Done when**: A valid request changes the login password and immediately makes
its bearer token unusable while another existing session remains unaffected;
every failed request preserves both the password and current session.

## Phase 8: Password Change Screen

**Goal**: Give the user a clear, accessible password-change flow that signs them
out after success.

**Affects**: frontend

**Tasks**:

- [ ] Add Playwright coverage for old, new, and confirmation fields; client and
      server failures; successful sign-out; rejected old-password login; and
      successful new-password login.
- [ ] Add a password form to the profile with separate old-password,
      new-password, and confirmation inputs and appropriate autocomplete
      semantics.
- [ ] Validate password length, byte limit, reuse, and confirmation locally
      while preserving authoritative field-level errors from the API.
- [ ] On success, clear the current browser session and send the user to sign in
      again; on failure, keep the session active and provide a clear recovery
      path.
- [ ] Use the project UI/UX workflow and verify focus, announcements, keyboard,
      desktop, and mobile behaviour through Playwright.

**Done when**: A user can change the password only by entering the correct old
password and valid matching new values, then is signed out and can authenticate
only with the new password.
