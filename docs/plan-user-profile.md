# Plan: User Profile

**PRD**: [prd-user-profile.md](prd-user-profile.md)
**Date**: 2026-08-12

## Implementation Phases

The plan delivers the profile in independently usable backend and frontend
increments. It starts with the smallest protected profile path, then adds avatar
management, identity on meeting-file uploads, and password change without
expanding into email changes, account lifecycle, or multi-device session
management. Each task is a cohesive result and includes its own automated tests,
documentation where applicable, and visual verification for user-interface work.

## Phase 1: Core Profile API (Tracer Bullet)

**Goal**: Let an authenticated user retrieve their safe account details and save
a display name through the API.

**Affects**: backend / database

**Tasks**:

- [ ] Implement and document the core current-user profile API as one complete
      TDD slice: persist an optional display name without changing registration;
      expose JWT-protected read and update operations returning only safe fields;
      keep email read-only; and reject invalid names without overwriting the
      saved value.

**Done when**: An authenticated API client can read only its own safe profile and
save a valid display name, while invalid names and unauthorized requests leave
profile data unchanged.

## Phase 2: Profile Screen and Display Name

**Goal**: Give the user a usable profile screen for viewing account information
and updating their display name.

**Affects**: frontend

**Tasks**:

- [ ] Deliver a protected profile overview that is reachable from the existing
      account interface, loads the current display name and read-only email, and
      handles missing or expired authentication.
- [ ] Deliver display-name management with trimmed 1–100 Unicode-character
      validation, field-level API errors, pending and success states, and
      preservation of the saved name after a failed update.
- [ ] Synchronize the current user's saved display name across existing account
      entry points immediately after an update, with the existing email fallback
      retained when no display name has been saved.

**Done when**: A signed-in user can open the profile, see a read-only email, save
a valid display name, and immediately see that name at existing self-identity
entry points.

## Phase 3: Avatar Management API

**Goal**: Let the current user safely upload, retrieve, replace, and remove their
avatar through authenticated API operations.

**Affects**: backend / database

**Tasks**:

- [ ] Deliver private avatar storage and protected current-user upload and
      retrieval operations, including avatar metadata, verified JPEG/PNG/WebP
      content, the 5 MB limit, self-only authorization, and API/storage tests.
- [ ] Deliver atomic avatar replacement so the previous avatar remains available
      until a valid replacement is fully stored and failed replacements leave no
      orphaned content, with regression coverage for failure paths.
- [ ] Deliver avatar removal and storage cleanup without modifying the account,
      including the avatar-absent profile contract, idempotent failure handling,
      end-to-end tests, and API/storage documentation.

**Done when**: An authenticated API client can manage only its own valid avatar;
invalid uploads keep the existing image, and removal leaves the account intact.

## Phase 4: Avatar Controls and Account Identity

**Goal**: Let users manage their avatar in the profile and see it or its fallback
at existing account entry points.

**Affects**: frontend

**Tasks**:

- [ ] Deliver a reusable accessible identity avatar that renders the current
      image or a neutral display-name fallback in the profile and existing
      account entry points, including safe image-error behaviour.
- [ ] Deliver avatar upload and replacement from the profile with client-side
      type and size checks, preview, pending and error states, and immediate
      synchronization of every visible current-user avatar.
- [ ] Deliver avatar removal from the profile with recoverable failure handling
      and immediate fallback synchronization across every current-user identity
      entry point.

**Done when**: A user can manage the avatar from the profile and every visible
self-identity entry point shows the current avatar or an accessible neutral
fallback.

## Phase 5: User Identity in Shared Activity API

**Goal**: Attach the uploader's current safe identity to meeting-file activity
that authorized meeting participants can see, without exposing private profile
data.

**Affects**: backend

**Tasks**:

- [ ] Deliver a safe uploader-identity contract in meeting-file responses that
      resolves the uploader's current display name and avatar state without
      exposing email or rewriting historical file records.
- [ ] Deliver meeting-scoped avatar retrieval using the same owner-or-participant
      access rule as the containing file activity, including denial outside the
      meeting, replacement/removal regression tests, and API documentation.

**Done when**: An owner or participant receives the uploader's current safe
identity with accessible meeting-file activity, while a user outside that
meeting cannot use the activity or avatar reference to retrieve it.

## Phase 6: User Identity in Shared Activity UI

**Goal**: Help meeting participants recognize who performed visible activity by
showing the actor's current avatar or fallback.

**Affects**: frontend

**Tasks**:

- [ ] Deliver uploader identification in the meeting-file list using the current
      display name or a neutral text fallback, without revealing email or
      linking to a private profile.
- [ ] Deliver authorized uploader-avatar rendering in meeting-file activity with
      the reusable fallback, safe unavailable-image behaviour, and refreshed
      identity after profile changes.

**Done when**: Every existing user-attributed activity visible to meeting
participants identifies its actor with the current avatar or neutral fallback,
without exposing private profile access.

## Phase 7: Password Change and Current-Session Revocation API

**Goal**: Let an authenticated user change their password using the old password
and make the session that performed the change unusable after success.

**Affects**: backend / database

**Tasks**:

- [ ] Deliver session-aware authentication with a unique identity for each issued
      JWT and selective revocation enforced by the authentication guard, while
      keeping a second existing session unaffected.
- [ ] Deliver and document the protected password-change operation with old,
      new, and confirmation validation, atomic hash replacement, secret-safe
      handling, caller-session revocation only after success, and complete
      end-to-end coverage of successful and failed credential transitions.

**Done when**: A valid request changes the login password and immediately makes
its bearer token unusable while another existing session remains unaffected;
every failed request preserves both the password and current session.

## Phase 8: Password Change Screen

**Goal**: Give the user a clear, accessible password-change flow that signs them
out after success.

**Affects**: frontend

**Tasks**:

- [ ] Deliver a secure password form with old, new, and confirmation fields,
      correct autocomplete semantics, local password-policy feedback,
      authoritative field-level API errors, and a recovery path that preserves
      the active session after failure.
- [ ] Deliver the successful credential-transition journey that clears the
      current browser session, redirects to sign-in, rejects the old password,
      and accepts the new password.

**Done when**: A user can change the password only by entering the correct old
password and valid matching new values, then is signed out and can authenticate
only with the new password.
