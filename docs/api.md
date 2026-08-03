# Video Meetings HTTP API

The API base URL is `http://localhost:3001`. Requests and responses use JSON.

## Public routes

| Method | Route            | Authentication |
| ------ | ---------------- | -------------- |
| POST   | `/auth/register` | None           |
| POST   | `/auth/login`    | None           |
| POST   | `/meetings`      | Bearer JWT     |
| GET    | `/meetings`      | Bearer JWT     |
| GET    | `/meetings/:id`  | Bearer JWT     |

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

| Field        | Rule                                                       |
| ------------ | ---------------------------------------------------------- |
| `title`      | Required string, trimmed, 1–255 characters after trimming. |
| `date`       | Required ISO 8601 date-time string.                        |
| Other fields | Rejected; clients cannot set `id` or `ownerId`.            |

Invalid input returns `400 Bad Request` and does not create a meeting.

### `GET /meetings`

Returns `200 OK` with an array containing only the authenticated user's
meetings. Results are ordered by creation time, newest first. An authenticated
user with no meetings receives `200 OK` and `[]`.

### `GET /meetings/:id`

Returns `200 OK` and a meeting when it belongs to the authenticated user.

If the meeting does not exist or belongs to another user, the endpoint returns
`404 Not Found`:

```json
{
  "statusCode": 404,
  "message": "Meeting not found"
}
```

Using the same response for absent and foreign meetings prevents identifier
enumeration and ownership disclosure.

## Running checks

End-to-end tests need PostgreSQL running with the `DATABASE_URL` from `.env`.
From the repository root, start the local database and run the tests:

```bash
npm run db:up
npm run test:e2e --workspace @video-meetings/api
```

The test suite covers registration, login, request validation, access-token
protection, meeting ownership, and non-disclosure of another user's meeting.

Run static checks separately:

```bash
npm run lint --workspace @video-meetings/api
npm run build --workspace @video-meetings/api
```

When finished, stop the local database with `npm run db:down`.
