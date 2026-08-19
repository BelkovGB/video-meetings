# Video Meetings HTTP API

The API base URL is `http://localhost:3001`. Responses use JSON; requests use
JSON except for the multipart file-upload endpoint.

## HTTP routes

| Method | Route                                                | Authentication     |
| ------ | ---------------------------------------------------- | ------------------ |
| POST   | `/auth/register`                                     | None               |
| POST   | `/auth/login`                                        | None               |
| GET    | `/users/me`                                          | Bearer JWT         |
| PATCH  | `/users/me`                                          | Bearer JWT         |
| POST   | `/users/me/password`                                 | Bearer JWT         |
| POST   | `/users/me/avatar`                                   | Bearer JWT         |
| GET    | `/users/me/avatar`                                   | Bearer JWT         |
| DELETE | `/users/me/avatar`                                   | Bearer JWT         |
| POST   | `/meetings`                                          | Bearer JWT         |
| GET    | `/meetings`                                          | Bearer JWT         |
| GET    | `/meetings/:id`                                      | Bearer JWT         |
| POST   | `/meetings/:meetingId/files`                         | Bearer JWT         |
| GET    | `/meetings/:meetingId/files`                         | Bearer JWT         |
| GET    | `/meetings/:meetingId/uploaders/:handle/avatar`      | Bearer JWT         |
| POST   | `/meetings/:meetingId/files/:fileId/download-ticket` | Bearer JWT         |
| GET    | `/file-downloads/:ticket`                            | One-time ticket    |
| DELETE | `/meetings/:meetingId/files/:fileId`                 | Bearer JWT (owner) |

`UsersModule` is an internal API module and does not expose HTTP routes.

## Request validation errors

Any endpoint that rejects a request body because it broke a DTO rule answers
with the same shape:

```json
{
  "statusCode": 400,
  "message": ["displayName must contain between 1 and 100 Unicode characters"],
  "error": "Bad Request",
  "code": "VALIDATION_FAILED",
  "fields": ["displayName"]
}
```

`message` is English prose for developers and is free to be reworded. A client
that shows its own text routes the failure by `code` and `fields`. A property of a
nested object is named by its dotted path, as in `parent.child`.

Rejections raised by a handler, a service or a guard instead of by validation
carry only the keys that code sets, usually just `{"message": …, "code": …}`.
Neither `statusCode` nor `error` is guaranteed outside the shape above, so route
those failures by `code` and the HTTP status alone.

## Authentication

Create an account or log in to obtain a JWT access token.

### `POST /auth/register`

Request:

```json
{
  "email": "user@example.com",
  "password": "secure-password-123"
}
```

Returns `201 Created` with:

```json
{
  "accessToken": "<JWT>"
}
```

Validation rules:

| Field      | Rule                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `email`    | Required valid email address; leading and trailing whitespace is removed.                                                                        |
| `password` | Required; at least 9 Unicode characters and no more than 72 UTF-8 bytes. Spaces and Unicode characters are accepted; no composition rules apply. |

Invalid input returns `400 Bad Request` and does not create an account.
A duplicate email returns `409 Conflict`.

### `POST /auth/login`

Accepts the same payload and returns `200 OK` with an `accessToken`.
Missing or invalid credentials return `401 Unauthorized`.

### Authentication rate limits

`POST /auth/register` and `POST /auth/login` share in-process fixed-window
limits to protect authentication work: at most 30 requests per client IP per
minute and at most 5 requests per normalized email address per 15 minutes.
Email addresses are normalized by trimming leading and trailing whitespace and
converting to lowercase before the account limit is applied. Requests to either
route count toward the same applicable limit.

After either limit is exhausted, the route returns `429 Too Many Requests`.
The response includes a `Retry-After` header containing the number of whole
seconds until the relevant window resets, plus this JSON body:

```json
{
  "statusCode": 429,
  "message": "Too many authentication attempts. Please try again later.",
  "retryAfterSeconds": 60
}
```

Clients should wait for the number of seconds in `Retry-After` before retrying.

By default the API does not trust forwarded client-IP headers. When it runs
behind a reverse proxy, set `TRUSTED_PROXY_IPS` to a comma-separated list of
only the proxy's IP addresses or CIDR ranges (for example,
`TRUSTED_PROXY_IPS=10.0.0.5,fd00:1::/64`). The proxy must be the only peer that
can connect to the API listener. This lets Express use `X-Forwarded-For` only
when the immediate peer is a known ingress; do not use a broad or public range.

## Current user profile

Profile operations require an access token. Send it in the HTTP header:

```http
Authorization: Bearer <accessToken>
```

Missing, malformed, or invalid tokens return `401 Unauthorized` and do not
change profile data.

### Profile representation

```json
{
  "id": "cm...",
  "email": "user@example.com",
  "displayName": "Ada Lovelace",
  "avatar": {
    "mimeType": "image/png",
    "sizeBytes": 24576,
    "updatedAt": "2026-08-15T12:00:00.000Z"
  }
}
```

`displayName` is `null` until it is first saved. The representation deliberately
contains only the caller's safe account fields: it never includes password
hashes, account timestamps, or avatar storage keys. `avatar` is `null` until an
avatar is uploaded. Email is read-only.

### `GET /users/me`

Returns `200 OK` with the safe profile for the authenticated user. The target is
always derived from the JWT, so there is no route or request field for reading
another user's profile.

### `PATCH /users/me`

Updates the authenticated user's display name and returns `200 OK` with the
updated safe profile.

Request:

```json
{
  "displayName": "Ada Lovelace"
}
```

Validation rules:

| Field         | Rule                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| `displayName` | Required string; trimmed; 1–100 Unicode characters after trimming.            |
| Other fields  | Rejected; clients cannot set a user ID, update another user, or change email. |

Invalid input returns `400 Bad Request` and leaves the existing display name
unchanged. There is no `/users/:id` profile endpoint.

### `POST /users/me/password`

Changes the authenticated user's password and returns `204 No Content`.

Request:

```json
{
  "currentPassword": "secure-password-123",
  "newPassword": "new-secure-password-456",
  "confirmation": "new-secure-password-456"
}
```

`currentPassword` must match the account's current password and use no more than
72 UTF-8 bytes, measured after NFC normalization. `newPassword` must differ from
it, contain at least 9 Unicode characters, and use no more than 72 UTF-8 bytes,
measured after NFC normalization. `confirmation` must exactly match the supplied
`newPassword` value. Invalid input or an incorrect current password
returns `400 Bad Request`; the password and the caller session remain valid.

Password-change attempts are limited to five per account in fifteen minutes and
thirty per client IP per minute. A rejected excess attempt returns `429 Too Many
Requests`; it does not change the password or revoke the caller session. The
wait is carried twice: in the `Retry-After` header and in the `retryAfterSeconds`
body field, both holding the number of whole seconds until the relevant window
resets.

```json
{
  "statusCode": 429,
  "message": "Too many password-change attempts. Please try again later.",
  "code": "PASSWORD_CHANGE_RATE_LIMITED",
  "retryAfterSeconds": 900
}
```

Browser clients read `retryAfterSeconds`, because the API exposes no custom
response headers through CORS and `Retry-After` is therefore unreadable from
page scripts. Dropping or renaming the field silently degrades the wait a client
can show to a guess.

These five codes are exhaustive for the `400` and `429` rejections of this
endpoint, because `message` is English prose that a localized client must not
parse. The `401` of a missing, legacy or revoked session and the `404` of a
deleted account carry no `code`:

| `code`                           | Status | Meaning                                             |
| -------------------------------- | ------ | --------------------------------------------------- |
| `VALIDATION_FAILED`              | 400    | A field broke a rule above; see request validation. |
| `CURRENT_PASSWORD_INCORRECT`     | 400    | `currentPassword` does not match the account.       |
| `NEW_PASSWORD_NOT_DIFFERENT`     | 400    | `newPassword` equals the current password.          |
| `PASSWORD_CONFIRMATION_MISMATCH` | 400    | `confirmation` differs from `newPassword`.          |
| `PASSWORD_CHANGE_RATE_LIMITED`   | 429    | The attempt limit above was exceeded.               |

On success, the password replacement and revocation of the account's JWT
sessions are atomic. Every session is revoked, not only the calling one: the
usual reason to change a password is a suspected compromise, and the API offers
no reset flow and no separate "sign out everywhere", so a token the user no
longer holds could not otherwise be evicted. Each of those JWTs is refused on
protected routes from the moment the change commits, and every device has to
sign in again with the new password. A legacy token without `sid` is the one
exception below: it has no session row, so it survives until it expires.
Passwords and password hashes are never included in responses or application
logs.

### JWT session migration rollout

New registration and login tokens include a session ID (`sid`) and are checked
against the persisted session on every protected request. To deploy this change
without globally invalidating still-valid tokens issued before `sid` existed,
the API accepts those legacy tokens by default (`ACCEPT_LEGACY_JWT_WITHOUT_SESSION=true`).
They continue to work on protected routes until their normal JWT expiry, but
cannot call `POST /users/me/password`: that operation returns `401` and requires
the user to sign in again, because a legacy token has no session row to revoke.
For the same reason a password change cannot evict a legacy token held by
someone else; that gap closes when the flag is turned off below.

Keep this compatibility setting enabled for at least the maximum JWT lifetime
(currently one hour) after deploying the version that starts issuing `sid`
tokens. Then set `ACCEPT_LEGACY_JWT_WITHOUT_SESSION=false` and redeploy. From
that point the guard rejects missing session IDs, and every protected JWT is
backed by a session row that a password change revokes.

## Meetings

Every meetings endpoint requires an access token. Send it in the HTTP header:

```http
Authorization: Bearer <accessToken>
```

Missing, malformed, or invalid tokens return `401 Unauthorized`.

### Meeting representation

```json
{
  "id": "cm...",
  "title": "Sprint planning",
  "date": "2026-08-03T10:00:00.000Z",
  "createdAt": "2026-08-02T18:00:00.000Z",
  "updatedAt": "2026-08-02T18:00:00.000Z"
}
```

`ownerId` is intentionally not returned. A meeting belongs to the authenticated
user who created it.

The detail route additionally returns the caller's safe authorization role
without exposing the owner's identifier:

```json
{
  "accessRole": "owner"
}
```

`accessRole` is `owner` for the meeting owner and `participant` for a recorded
participant. Detail and collection responses include it; creation keeps the base
representation.

### `POST /meetings`

Creates a meeting owned by the authenticated user.

Request:

```json
{
  "title": "Sprint planning",
  "date": "2026-08-03T10:00:00.000Z"
}
```

Returns `201 Created` and the meeting representation.

Validation rules:

| Field        | Rule                                                        |
| ------------ | ----------------------------------------------------------- |
| `title`      | Required string, trimmed, 1–255 characters after trimming.  |
| `date`       | Required ISO 8601 date-time string; year must be 2000–2100. |
| Other fields | Rejected; clients cannot set `id` or `ownerId`.             |

Invalid input returns `400 Bad Request` and does not create a meeting.

### `GET /meetings`

Returns `200 OK` with meetings where the authenticated user is the owner or a
recorded participant. Results are ordered by creation time, newest first, and
every item includes `accessRole` set to `owner` or `participant`. An authenticated
user with no available meetings receives `200 OK` and `[]`.

### `GET /meetings/:id`

Returns `200 OK`, the meeting, and `accessRole` when the authenticated user is
its owner or a recorded participant.

If the meeting does not exist or the user has no access, the endpoint returns
`404 Not Found`:

```json
{
  "statusCode": 404,
  "message": "Meeting not found"
}
```

Using the same response for absent and foreign meetings prevents identifier
enumeration and ownership disclosure.

## Current-user avatars

Avatars are private user assets. Every route in this section uses the JWT subject
from the bearer token; neither a target user ID nor another user's avatar route
is accepted. Another user reads an avatar only through the shared activity that
carries its owner's identity — see
`GET /meetings/:meetingId/uploaders/:handle/avatar`. The profile's `avatar`
field is `null` until an avatar exists, then contains only verified media
metadata (`mimeType`, `sizeBytes`, and `updatedAt`) and never an internal
storage key.

### `POST /users/me/avatar`

Accepts `multipart/form-data` with exactly one file field named `avatar` and
returns `201 Created` with its safe metadata. JPEG (`image/jpeg`), PNG
(`image/png`), and WebP (`image/webp`) are accepted only when the supplied MIME
and filename extension agree and the complete payload decodes as that image
format. The maximum file size is `AVATAR_MAX_BYTES` (5 MiB by default). Empty,
malformed, unsupported, and oversized uploads are rejected with `400`,
`415 UNSUPPORTED_AVATAR_TYPE`, or `413 AVATAR_TOO_LARGE` and are removed before
a user record or final object is created.

### `GET /users/me/avatar`

Streams the authenticated user's avatar with the verified content type,
`Content-Length`, `Cache-Control: private, no-store`, and
`X-Content-Type-Options: nosniff`. A user without an avatar receives `404`; one
authenticated user cannot retrieve another user's avatar.

### `DELETE /users/me/avatar`

Removes the authenticated user's avatar and returns `200 OK` with the same safe
profile representation as `GET /users/me`, with `avatar: null`. It accepts no
target user ID. The `null` value is the stable avatar-absent contract: a later
`GET /users/me/avatar` returns `404`, while the account, email, display name,
and other profile fields remain unchanged. Removal is idempotent, so repeated
authenticated requests also return `200` and the avatar-absent profile; an
unauthenticated request returns `401`.

The API clears avatar metadata atomically before discarding the private object.
If private-storage cleanup is temporarily unavailable, it still returns the
avatar-absent profile and queues cleanup for storage reconciliation. It never
includes a storage key or filesystem path in the response or error.

Avatar files use a storage root separate from meeting files. `AVATAR_DIR` holds
final files and `AVATAR_TEMP_DIR` holds short-lived upload parts; both must be
on the same filesystem for an atomic move. The API creates these private
directories at startup and does not expose either directory through the web
application.

At startup, the API removes only avatar `.part` files older than
`AVATAR_TEMPORARY_UPLOAD_GRACE_MS`. This safety window prevents a newly started
API instance from deleting an upload still being validated by another instance
that shares the avatar volume.

## Meeting files

The owner of a meeting and its recorded participants can upload one allowed file
at a time and list the files already attached to it. Membership management is
not exposed by this API yet; the file routes enforce the shared owner-or-
participant access policy.

### `POST /meetings/:meetingId/files`

Accepts `multipart/form-data` with exactly one field named `file`. The JWT and
meeting access check run before multipart parsing, so a user outside the meeting
cannot create a temporary file.

The server writes the upload to `UPLOAD_TEMP_DIR`, validates its size, supplied
MIME type, extension, and file signature, then atomically moves it to
`UPLOAD_DIR` under a random internal key. The original filename is never used as
a filesystem path.

The local MVP accepts at most one active upload per authenticated user and four
active uploads per API process by default. A conflicting upload returns `409`
with `UPLOAD_BUSY`. Stale temporary files and final objects without matching
database metadata are reconciled after a 24-hour safety window; a READY record
whose object disappeared is moved to `MISSING`.

Accepted formats are MP3, M4A, WAV, OGG, MP4, WebM, MOV, TXT, VTT, SRT, PDF,
and DOCX. Their MIME types must match the allowlist in
[`research-meetings-upload.md`](research-meetings-upload.md). The maximum file
size is `UPLOAD_MAX_BYTES` (1 GiB by default).

Successful requests return `201 Created`:

```json
{
  "id": "cm...",
  "name": "retrospective.mp4",
  "category": "video",
  "mimeType": "video/mp4",
  "sizeBytes": 734003200,
  "uploadedAt": "2026-08-11T10:00:00.000Z",
  "uploadedBy": {
    "handle": "T5cfLgm1Vb2VhV8Xz3rRDQ",
    "displayName": "Ada Lovelace",
    "avatar": { "updatedAt": "2026-08-11T09:00:00.000Z" }
  }
}
```

`uploadedBy` is the uploader's safe identity, read from the user record on every
request, so a renamed uploader or a replaced avatar shows the current value
without rewriting stored files. It carries only an opaque handle, a display
name, and the avatar state: email, the user ID, and every other private profile
value stay out. The avatar bytes are served only by
`GET /meetings/:meetingId/uploaders/:handle/avatar` below, never by a route that
names the uploader.

`handle` identifies the uploader within this meeting alone. Every file the same
person uploaded to the meeting carries the same value, so a client can group
them and fetch one avatar for all of them; the same person in another meeting
gets an unrelated value that this meeting's routes reject, and the user ID
cannot be derived from either. That is an authorization boundary, not
anonymity: `displayName` and `avatar.updatedAt` — the latter also driving the
avatar route's `ETag` — are the same values in every meeting, so a caller who
shares two meetings with the uploader can still match the two handles to one
person.

`displayName` is `null` until the uploader sets one, `avatar` is `null` while
the uploader has none, and
`uploadedBy` itself is `null` when the uploading account no longer exists — the
file stays listed and downloadable. Only the meeting owner and its participants
ever see it; an outsider receives the same `404 Meeting not found` as before.

Invalid multipart requests return `400` with `INVALID_MULTIPART_UPLOAD`; a
missing file returns `400` with `MISSING_UPLOAD`; files larger than the limit
return `413` with `UPLOAD_TOO_LARGE`; unsupported names, MIME types, extensions,
or content return `415` with `UNSUPPORTED_FILE_TYPE`. A missing or inaccessible
meeting returns the same `404 Meeting not found` response.

### `GET /meetings/:meetingId/files`

Returns `200 OK` with the same metadata representation for each ready file,
newest first. Internal storage keys and uploader IDs are never returned.

### `GET /meetings/:meetingId/uploaders/:handle/avatar`

`:handle` is the `uploadedBy.handle` value of a meeting file. The route streams
that uploader's avatar to the meeting owner or a participant, with the verified
content type, `Content-Length`, and `X-Content-Type-Options: nosniff`. This is
the only way another user reads that avatar: the meeting is the subject, so the
caller needs no uploader ID, gets no other profile field, and cannot reach the
avatar of a user they share no meeting with.

Access is the containing meeting's own. An outsider receives the same
`404 Meeting not found` as the meeting-file routes, an unauthenticated request
receives `401`, and a handle that names nobody with a ready file in this
meeting — including one minted for another meeting — receives
`404 Avatar not found`.

The user record is read on every request rather than captured at upload time, so
a historical file never serves a stale avatar: after a replacement the route
streams the new image, and after a removal, for an uploader who never set one,
or for a deleted uploader account it returns `404 Avatar not found`.

Caching is revalidated, not skipped, because the URL is authorization-dependent:
a successful response carries `Cache-Control: private, max-age=0, must-revalidate`,
an `ETag` derived from the avatar's current version, and `Authorization` appended
to `Vary` — appended, so the `Origin` the CORS layer contributes survives and the
full field reads `Vary: Origin, Authorization`.
`max-age=0` is stated rather than implied so no cache assigns a heuristic
lifetime and reuses a replaced avatar unchecked. A request repeating the tag in
`If-None-Match` receives `304 Not Modified` without a body, carrying the same
tag and directives, and receives the new image with a new tag once the uploader
replaces the avatar. Every `404` of this route instead carries
`Cache-Control: private, no-store` and never the avatar's validator, so a denial
is neither stored and replayed to a caller who does have access, nor
revalidated later and served in place of the image.

Because the handle is shared by every file of one uploader, a meeting with many
files from one person costs one avatar request per uploader instead of one per
file. Whether the next view revalidates or refetches is not guaranteed:
`Vary: Authorization` keys the stored response on the exact bearer token, so a
token rotation produces a full response rather than a `304`.

### `POST /meetings/:meetingId/files/:fileId/download-ticket`

The meeting owner or a participant can create a download ticket for a ready
file. The JWT-protected request returns `201 Created`:

```json
{
  "ticket": "<random-one-time-token>",
  "expiresAt": "2026-08-11T10:01:00.000Z"
}
```

The raw 256-bit ticket is returned only once. PostgreSQL stores its SHA-256 hash,
the issuing user, and a 60-second expiration time.

### `GET /file-downloads/:ticket`

Redeems a valid ticket exactly once and streams the file with download headers.
The response includes `Content-Length`, the verified `Content-Type`, a safe
`Content-Disposition`, `Cache-Control: private, no-store`, and
`X-Content-Type-Options: nosniff`. The server rechecks the issuing user's current
meeting access before opening the file. Missing, expired, used, or revoked
tickets return `404 Not Found`.

### `DELETE /meetings/:meetingId/files/:fileId`

Only the meeting owner can delete a ready file. A participant receives
`403 Forbidden`; an outsider receives the same `404 Meeting not found` response
used by other meeting-file routes. The API marks metadata as `DELETING`, removes
the storage object, deletes the metadata and its download tickets, then returns
`204 No Content`. Deleted files no longer appear in the list or download. If a
storage or database operation fails after the status transition, a background
reconciler retries the hidden deletion after one minute.

## Local upload configuration

| Variable                           | Default               | Purpose                                              |
| ---------------------------------- | --------------------- | ---------------------------------------------------- |
| `UPLOAD_DIR`                       | `./var/uploads`       | Permanent local file storage.                        |
| `UPLOAD_TEMP_DIR`                  | `./var/uploads-temp`  | Temporary upload storage on the same filesystem.     |
| `UPLOAD_MAX_BYTES`                 | `1073741824`          | Per-file byte limit.                                 |
| `UPLOAD_MAX_REQUEST_BYTES`         | `1074790400`          | Multipart request limit, including overhead.         |
| `UPLOAD_MIN_FREE_BYTES`            | `2147483648`          | Reserved free capacity for the storage volume.       |
| `UPLOAD_MAX_ACTIVE_UPLOADS`        | `4`                   | Maximum active uploads in one API process.           |
| `UPLOAD_RECONCILIATION_GRACE_MS`   | `86400000`            | Safety window for stale and orphan cleanup.          |
| `AVATAR_DIR`                       | `./var/avatars/files` | Permanent private avatar storage.                    |
| `AVATAR_TEMP_DIR`                  | `./var/avatars/temp`  | Temporary avatar storage on the same filesystem.     |
| `AVATAR_MAX_BYTES`                 | `5242880`             | Maximum avatar size (5 MiB).                         |
| `AVATAR_TEMPORARY_UPLOAD_GRACE_MS` | `3600000`             | Safety window before stale avatar parts are removed. |

The API creates the directories with private permissions at startup, removes
only stale avatar `.part` files from interrupted uploads, and refuses to start
if the temporary and permanent paths are on different filesystems.

## Running checks

End-to-end tests need PostgreSQL running with the `DATABASE_URL` from `.env`.
From the repository root, start the local database and run the tests:

```bash
npm run db:up
npm run test:e2e --workspace @video-meetings/api
```

The test suite covers registration, login, request validation, access-token
protection, meeting ownership, meeting-file upload/listing/download/deletion,
file validation, one-time tickets, and non-disclosure of another user's meeting.

Run static checks separately:

```bash
npm run lint --workspace @video-meetings/api
npm run build --workspace @video-meetings/api
```

When finished, stop the local database with `npm run db:down`.
