# Current-user avatar API

All avatar operations are scoped to the authenticated user. They never accept a
target user ID or expose a storage key or filesystem path.

## Removal

`DELETE /users/me/avatar` removes the authenticated user's avatar and returns
`200 OK` with the same safe profile representation as `GET /users/me`:

```json
{
  "id": "user-id",
  "email": "user@example.com",
  "displayName": "Example user",
  "avatar": null
}
```

`avatar: null` is the stable avatar-absent contract. A subsequent
`GET /users/me/avatar` returns `404`, while the user account, email, and display
name remain unchanged. Removal is idempotent: repeated authenticated requests
return `200` and the same avatar-absent representation. Unauthenticated removal
returns `401`.

Avatar metadata is cleared atomically before private content is discarded. If
private-storage cleanup is temporarily unavailable, the API still returns the
avatar-absent profile without revealing a storage path; cleanup is queued for
the storage service's reconciliation cycle. This keeps the profile state
consistent while allowing transient storage failures to recover safely.
