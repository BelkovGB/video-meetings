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
| POST   | `/users/me/avatar`                                   | Bearer JWT         |
| GET    | `/users/me/avatar`                                   | Bearer JWT         |
| POST   | `/meetings`                                          | Bearer JWT         |
| GET    | `/meetings`                                          | Bearer JWT         |
| GET    | `/meetings/:id`                                      | Bearer JWT         |
| POST   | `/meetings/:meetingId/files`                         | Bearer JWT         |
| GET    | `/meetings/:meetingId/files`                         | Bearer JWT         |
| POST   | `/meetings/:meetingId/files/:fileId/download-ticket` | Bearer JWT         |
| GET    | `/file-downloads/:ticket`                            | One-time ticket    |
| DELETE | `/meetings/:meetingId/files/:fileId`                 | Bearer JWT (owner) |

`UsersModule` is an internal API module and does not expose HTTP routes.

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

Avatars are private user assets. Every avatar route uses the JWT subject from
the bearer token; neither a target user ID nor another user's avatar route is
accepted. The profile's `avatar` field is `null` until an avatar exists, then
contains only verified media metadata (`mimeType`, `sizeBytes`, and `updatedAt`)
and never an internal storage key.

### `POST /users/me/avatar`

Accepts `multipart/form-data` with exactly one file field named `avatar` and
returns `201 Created` with its safe metadata. JPEG (`image/jpeg`), PNG
(`image/png`), and WebP (`image/webp`) are accepted only when the supplied MIME,
filename extension, and binary container structure agree. The maximum file size is
`AVATAR_MAX_BYTES` (5 MiB by default). Empty, malformed, unsupported, and
oversized uploads are rejected with `400`, `415 UNSUPPORTED_AVATAR_TYPE`, or
`413 AVATAR_TOO_LARGE` and are removed before a user record or final object is
created.

### `GET /users/me/avatar`

Streams the authenticated user's avatar with the verified content type,
`Content-Length`, `Cache-Control: private, no-store`, and
`X-Content-Type-Options: nosniff`. A user without an avatar receives `404`; one
authenticated user cannot retrieve another user's avatar.

Avatar files use a storage root separate from meeting files. `AVATAR_DIR` holds
final files and `AVATAR_TEMP_DIR` holds short-lived upload parts; both must be
on the same filesystem for an atomic move. The API creates these private
directories at startup and does not expose either directory through the web
application.

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
  "uploadedAt": "2026-08-11T10:00:00.000Z"
}
```

Invalid multipart requests return `400` with `INVALID_MULTIPART_UPLOAD`; a
missing file returns `400` with `MISSING_UPLOAD`; files larger than the limit
return `413` with `UPLOAD_TOO_LARGE`; unsupported names, MIME types, extensions,
or content return `415` with `UNSUPPORTED_FILE_TYPE`. A missing or inaccessible
meeting returns the same `404 Meeting not found` response.

### `GET /meetings/:meetingId/files`

Returns `200 OK` with the same metadata representation for each ready file,
newest first. Internal storage keys and uploader IDs are never returned.

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

| Variable                         | Default               | Purpose                                          |
| -------------------------------- | --------------------- | ------------------------------------------------ |
| `UPLOAD_DIR`                     | `./var/uploads`       | Permanent local file storage.                    |
| `UPLOAD_TEMP_DIR`                | `./var/uploads-temp`  | Temporary upload storage on the same filesystem. |
| `UPLOAD_MAX_BYTES`               | `1073741824`          | Per-file byte limit.                             |
| `UPLOAD_MAX_REQUEST_BYTES`       | `1074790400`          | Multipart request limit, including overhead.     |
| `UPLOAD_MIN_FREE_BYTES`          | `2147483648`          | Reserved free capacity for the storage volume.   |
| `UPLOAD_MAX_ACTIVE_UPLOADS`      | `4`                   | Maximum active uploads in one API process.       |
| `UPLOAD_RECONCILIATION_GRACE_MS` | `86400000`            | Safety window for stale and orphan cleanup.      |
| `AVATAR_DIR`                     | `./var/avatars/files` | Permanent private avatar storage.                |
| `AVATAR_TEMP_DIR`                | `./var/avatars/temp`  | Temporary avatar storage on the same filesystem. |
| `AVATAR_MAX_BYTES`               | `5242880`             | Maximum avatar size (5 MiB).                     |

The API creates the directories with private permissions at startup and refuses
to start if the temporary and permanent paths are on different filesystems.

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
