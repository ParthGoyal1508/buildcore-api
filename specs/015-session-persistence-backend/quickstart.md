# Quickstart — Session Persistence (Backend)

Validation that only shows up against a running instance. The unit and e2e suites cover the logic;
these cover the parts that involve a real cookie jar and a real clock.

## Prerequisites

```bash
npm ci
npx prisma migrate deploy          # includes the rememberMe drop
npm run start:dev                  # API on :3000
```

A seeded local database (`npm run db:demo`) gives you `rajesh.kulkarni@parthrealcon.com` /
`secret42`.

## Pass 1 — A session is 90 days and slides (US1, SC-001)

```bash
# Sign in, keeping the cookie jar.
curl -s -c jar.txt -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"rajesh.kulkarni@parthrealcon.com","password":"secret42"}' > /dev/null

grep refresh jar.txt          # expect an expiry ~90 days out, not a session cookie
```

**Expect**: the cookie has a `Max-Age`/expiry roughly 90 days ahead. A `0` in the expiry column
(a browser-session cookie) means `maxAge` is still conditional and FR-001 has not landed.

Then renew and confirm the window *moves* rather than counting down:

```bash
curl -s -b jar.txt -c jar.txt -X POST localhost:3000/auth/refresh-token | head -c 80
grep refresh jar.txt          # expiry should now be ~90 days from *now*, not from sign-in
```

## Pass 2 — Omitting `rememberMe` is accepted (FR-003)

The sign-in above already omits it. Also confirm an older client still works:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"rajesh.kulkarni@parthrealcon.com","password":"secret42","rememberMe":false}'
```

**Expect** `201`. A `400` means the field was removed from the DTO instead of being ignored, which
would break the deployed web build.

## Pass 3 — Concurrency is not theft (US2, SC-002, SC-003)

The scenario that has already destroyed five production sessions. Present the *same* credential
several times at once:

```bash
for i in 1 2 3 4 5; do
  curl -s -b jar.txt -o /dev/null -w "$i:%{http_code} " -X POST localhost:3000/auth/refresh-token &
done; wait; echo
curl -s -b jar.txt -o /dev/null -w 'after:%{http_code}\n' -X POST localhost:3000/auth/refresh-token
```

**Expect**: every parallel call `201`, and the follow-up `201` — the session survived. Any `401`
carrying `SESSION_REVOKED` means the tolerance is still too narrow.

Repeat with the presentations spread over ~30 s to simulate a cold instance; the result must be
the same. That spread is the case the old five-second window got wrong.

## Pass 4 — Genuine replay is still caught (FR-006, SC-004)

Take a copy of the cookie jar, rotate the real one twice, then present the stale copy well after
the tolerance has passed:

```bash
cp jar.txt stale.txt
curl -s -b jar.txt -c jar.txt -X POST localhost:3000/auth/refresh-token > /dev/null
sleep 65                                       # exceed reuseGraceSeconds
curl -s -b stale.txt -X POST localhost:3000/auth/refresh-token | head -c 120; echo
curl -s -b jar.txt -o /dev/null -w 'live session after replay: %{http_code}\n' \
  -X POST localhost:3000/auth/refresh-token
```

**Expect**: the stale presentation returns `401` with `"code":"SESSION_REVOKED"`, **and** the
previously-live session is now also `401` — the whole family is destroyed, which is the protection
working. Confirm an audit entry was written for it (FR-007).

## Pass 5 — Cookie attributes follow configuration (FR-009, FR-010)

```bash
REFRESH_COOKIE_PATH=/bff/auth REFRESH_COOKIE_SAMESITE=lax npm run start:dev
curl -s -D - -o /dev/null -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"rajesh.kulkarni@parthrealcon.com","password":"secret42"}' | grep -i set-cookie
```

**Expect** `Path=/bff/auth; SameSite=Lax; HttpOnly; Secure`. This is the setting the proxied
deployment uses; getting it wrong is the one way the web change fails to work at all.

## Pass 6 — Nothing live is invalidated by deploying (FR-004, SC-005)

Against a database seeded *before* the migration: sign in, apply `prisma migrate deploy`, then
renew with the cookie obtained beforehand.

**Expect** `201`. The session survives the migration and its replacement carries a 90-day expiry.

## Pass 7 — Cleanup leaves a forensic tail (FR-013)

Run the cleanup job with retention set low and confirm it removes long-expired rows while leaving
recently-revoked ones in place, so a destroyed family can still be inspected alongside its audit
entry.
