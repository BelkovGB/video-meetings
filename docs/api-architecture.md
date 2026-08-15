# API architecture

## Modules

- `AuthModule` verifies credentials, hashes passwords, issues JWTs, and exports
  `JwtAuthGuard` and its JWT configuration for protected modules.
- `UsersModule` owns credential-oriented user persistence. It exposes
  `UsersSecurityPort` as its security boundary for creating users and finding a
  user by email.
- `ProfileModule` owns the protected current-user profile and avatar HTTP APIs.
  It reads and updates only safe profile fields for the authenticated user and
  owns private avatar storage separately from meeting files.
- `MeetingsModule` owns the meetings HTTP API and uses CQRS for all operations.
- `FilesModule` owns local meeting-file storage and its protected HTTP API.
- `PrismaModule` owns the shared Prisma database client.

## CQRS in `MeetingsModule`

Controllers contain no application or database logic. They validate the HTTP
payload, authenticate the caller, then dispatch one message through Nest CQRS.

```mermaid
flowchart LR
  Client --> Controller
  Controller --> Guard["JwtAuthGuard"]
  Guard --> Controller
  Controller --> Bus{"CommandBus or QueryBus"}
  Bus --> Handler
  Handler --> PrismaService
  PrismaService --> PostgreSQL
```

| HTTP operation      | CQRS message           | Handler                | Responsibility                                 |
| ------------------- | ---------------------- | ---------------------- | ---------------------------------------------- |
| `POST /meetings`    | `CreateMeetingCommand` | `CreateMeetingHandler` | Creates a meeting for the authenticated owner. |
| `GET /meetings`     | `GetMeetingsQuery`     | `GetMeetingsHandler`   | Reads meetings available to the current user.  |
| `GET /meetings/:id` | `GetMeetingQuery`      | `GetMeetingHandler`    | Reads one available meeting or raises `404`.   |

Commands change state. Queries only read state. `meetingSelect` is the shared
read model selection; it ensures every meeting response excludes `ownerId`.

## Authentication and users boundary

`AuthModule` owns authentication decisions: it validates a registration attempt,
hashes and verifies passwords, handles duplicate and invalid-credential errors,
and issues JWTs. It does not access Prisma or the `User` model directly.

Instead, it depends on the `UsersSecurityPort` token exported by `UsersModule`.
The port offers only the credential-oriented operations authentication needs:
create a user and find one by email. `UsersModule` implements that contract with
`UsersService`. It owns the Prisma queries that return credential material,
including password hashes. This security pattern keeps hashes inside the
module-to-module boundary while preventing authentication from depending on the
users persistence implementation.

`ProfileModule` is deliberately outside `UsersSecurityPort`: profile reads,
updates, and avatar operations are not credential operations. It imports
`AuthModule` only for `JwtAuthGuard`, takes the caller ID exclusively from the
verified JWT `sub`, and uses `PrismaModule` to select or update `id`, `email`,
`displayName`, and private avatar metadata. It never selects password hashes,
and it has no operation accepting a target user ID or an email update. Thus
`AuthModule` has no direct Prisma or `User` model dependency, `UsersModule` does
not expose general user CRUD, and the profile HTTP surface is limited to
`GET`/`PATCH /users/me` and `POST`/`GET /users/me/avatar` documented in
`docs/api.md`.

There is no general users controller: user creation and credential lookup are
available only through the security port, while the profile controller exposes
only the authenticated caller's safe profile. The former unconsumed root health
route is intentionally not part of the application.

## Avatar storage

`ProfileController` accepts one authenticated multipart `avatar` upload only
for the JWT subject. It writes the candidate to `AVATAR_TEMP_DIR`, then
`AvatarValidationService` uses the image decoder to verify that JPEG, PNG, or
WebP content can be decoded and matches the supplied extension and MIME type.
Only then does `LocalAvatarStorageService` atomically move it to the separate
private `AVATAR_DIR/<storageKey>/content` object store and the profile service
writes its metadata to the user row. Failed validation and failed persistence
discard the candidate or final object. Startup removes only `.part` files older
than the configured safety window, so a second API instance cannot remove an
active upload on a shared storage volume. Retrieval has only `GET /users/me/avatar`, which
streams the requesting user's verified object with private, non-sniffable
headers. Neither the profile response nor the HTTP API exposes storage keys.

## Ownership and authorization

The JWT payload contains the user ID in `sub`. `JwtAuthGuard` verifies the token
and attaches that payload to the Nest request. The controller passes only `sub`
to the command or query. Collection and detail queries accept either the owner
or a `MeetingParticipant` and return a derived `accessRole` instead of exposing
`ownerId`. Authorization remains enforced where data is accessed rather than
relying on controller logic.

`GetMeetingHandler` deliberately returns the same `404` for an inaccessible and
a missing ID. This prevents a caller from discovering another user's meetings.

`FilesModule` extends that rule with `MeetingAccessService`, the single policy
for a meeting owner or a `MeetingParticipant`. Its guard runs after JWT
verification and before Nest's Multer interceptor, so an outsider gets the same
`404` before any upload bytes are retained. The service repeats the access check
before it commits a validated upload, covering a participant whose membership
was revoked during a long transfer.

## Meeting file storage

`FilesController` accepts exactly one multipart field (`file`) and delegates to
`MeetingFilesService`. Multer streams that field to `UPLOAD_TEMP_DIR`; the
service validates the approved extension/MIME/signature combination, generates a
256-bit storage key, atomically renames the temporary file to
`UPLOAD_DIR/<storageKey>/content`, then writes a `MeetingFile` metadata row.
If database creation fails, it removes the final file as compensation.

Before Multer starts, the upload capacity guard atomically reserves the complete
`Content-Length` in the single API process. The reservation is released on every
request completion path and prevents concurrent uploads from violating the
configured free-space reserve.

The filesystem implementation is isolated in `LocalMeetingFileStorageService`.
No database record stores an absolute path, and neither storage keys nor uploader
IDs are returned in the API representation. `MeetingFile` is associated with one
meeting and records its original display name, inferred category, verified MIME
type, byte size, status, and upload timestamp. Listing and download ticket
creation return only `READY` records.

Downloads use a two-step flow so a browser does not need to place its JWT in a
URL or buffer a potentially 1 GiB response. An authenticated owner or participant
creates a 256-bit, 60-second ticket. Only its SHA-256 hash is persisted. The
public download controller atomically marks the ticket used, rechecks the
issuing user's current access, and streams the local file with private,
non-sniffable attachment headers.

Deletion is restricted to the meeting owner. In a transaction, the service
atomically claims the file by changing it from `READY` to `DELETING`; it then
removes the storage directory and deletes the metadata row. Tickets cascade with
the metadata. A second concurrent delete cannot claim the same row.

Failed storage or database deletion leaves the hidden `DELETING` row and its
storage key. A single-process reconciliation service runs at application startup
and every minute, retrying rows whose `updatedAt` is at least one minute old so
it does not race an active request. If a download discovers missing local
content, the metadata moves to `MISSING` and is excluded from subsequent
list/download operations.

## Persistence and migrations

Prisma models live in `apps/api/prisma/schema.prisma`; SQL migrations are stored
in `apps/api/prisma/migrations` and must be committed with schema changes.

The meetings ownership migration preserves pre-existing meetings by leaving
their `owner_id` as `NULL`. They are intentionally excluded from authenticated
queries until an approved ownership-backfill process assigns them to users.

For schema work, run:

```bash
npm run prisma:generate --workspace @video-meetings/api
npm run prisma:migrate --workspace @video-meetings/api -- --name describe-your-change
```
