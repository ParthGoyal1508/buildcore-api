# Contract — Session endpoints

Only what this feature changes. Paths, methods and success shapes are otherwise as they are today.

## `POST /auth/login`

**Request** — `rememberMe` becomes optional and is **ignored**.

```jsonc
{
  "identifier": "rajesh.kulkarni@parthrealcon.com",
  "password": "…",
  "rememberMe": false   // optional; accepted for compatibility, has no effect
}
```

Retained rather than removed because `forbidNonWhitelisted` is enabled globally: a deployed web
build still sending the field would receive a 400 the moment this ships, and the two services
deploy independently.

**Response** — unchanged (`accessToken`, `name`, `mustChangePassword`).

**`Set-Cookie`** — changed:

| Attribute | Before | After |
|---|---|---|
| `Max-Age` | present only when `rememberMe` | **always**, `sessionDays` (90 d) |
| `Path` | `/auth` | `refreshCookie.path`, default `/auth` |
| `SameSite` | `none` when `CORS_ORIGINS` set, else `strict` | `refreshCookie.sameSite`, default `lax` |
| `HttpOnly`, `Secure` | set | unchanged |

## `POST /auth/refresh-token`

**Success** — unchanged (`accessToken`, plus a rotated cookie carrying a fresh 90-day expiry).

**Failure** — still `401`, now carrying a machine-readable `code`:

```jsonc
{ "statusCode": 401, "message": "…", "code": "SESSION_EXPIRED" }
```

| `code` | Meaning | Client should |
|---|---|---|
| `SESSION_EXPIRED` | Credential unknown, expired, or already revoked. | Sign the user out, saying the session expired. |
| `SESSION_REVOKED` | Reuse detection has just destroyed the family. | Sign the user out. Distinguishable so a security event is not reported as ordinary expiry. |

Absent a `code`, a client must treat a 401 as it does today. Branching is on `code`, never on
`message` — the mechanism `ApiError.code` and `PASSWORD_CHANGE_REQUIRED` already use.

### Tolerated concurrency

Presenting a credential that has already been rotated is **not** an error while it is within
`reuseGraceSeconds` (default 60) of its first use: it rotates again and the session survives. This
is the ordinary case of one client discovering a lapsed working credential in several requests at
once, and it must not be reported as theft.

Beyond that window the entire family is revoked, the response carries `SESSION_REVOKED`, and an
audit entry is written recording the account, the family, and how far outside the window the
presentation fell.

## `POST /auth/logout`

Unchanged in shape. The cleared cookie's `Path` and `SameSite` are read from the same
configuration used to set it, so the two cannot drift — a mismatch would leave the credential in
place after a sign-out.
