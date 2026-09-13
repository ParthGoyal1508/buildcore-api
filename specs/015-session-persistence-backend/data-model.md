# Phase 1 Data Model — Session Persistence (Backend)

One model changes. No model is added.

## `shared."RefreshToken"`

| Field | Change | Note |
|---|---|---|
| `id`, `tokenHash`, `familyId`, `accountId`, `companyId` | unchanged | |
| `rememberMe` `Boolean` | **REMOVED** | Inert once every session shares one duration (research §1). Kept nowhere: a written-but-unread column misleads the next reader into thinking sessions still differ by it. |
| `used`, `usedAt` | unchanged | `usedAt` is the origin of the reuse tolerance measurement. |
| `revokedAt` | unchanged | Set on logout and on reuse detection. |
| `expiresAt` | unchanged **shape**, new value | Now always `now + sessionDays` (90), re-derived on every rotation. Existing rows are left exactly as they are. |
| `createdAt` | unchanged | |

### Migration

`ALTER TABLE "shared"."RefreshToken" DROP COLUMN "rememberMe";`

Safe against FR-004 because expiry is carried by `expiresAt`, which the migration does not touch.
Every live session keeps its current expiry and adopts the 90-day window at its next rotation.

Irreversible in the sense that the recorded preference is gone. That is intended: the product no
longer offers the choice, so preserving per-row answers to a question nobody is asked would be
preserving noise.

### Retention

Rows are deleted once `expiresAt` **or** `revokedAt` is more than `cleanupRetentionDays` (default
7) in the past. The delay exists so a family destroyed by reuse detection still has its rows while
someone reads the audit entry describing it.

## State transitions

A token is created unused, becomes used exactly once under normal rotation, and may be revoked.

```
        created ──rotate──▶ used ──────────────▶ (deleted after retention)
           │                 │
           │                 └──presented again──▶ within tolerance: rotate again, stay used
           │                                       outside tolerance: whole family revoked
           └──logout / family revoked──▶ revoked ─▶ (deleted after retention)
```

The only change to this shape is where the "within tolerance" boundary falls, and that it is now
configuration rather than a constant.

## Configuration (`SecurityConfig`)

| Setting | Env | Default | Replaces |
|---|---|---|---|
| `refreshToken.sessionDays` | `SESSION_DAYS` | `90` | `rememberMeDays: 30`, `defaultDays: 1` |
| `refreshToken.reuseGraceSeconds` | `REFRESH_REUSE_GRACE_SECONDS` | `60` | `REUSE_GRACE_WINDOW_MS = 5_000` (a module constant) |
| `refreshToken.cleanupRetentionDays` | `REFRESH_CLEANUP_RETENTION_DAYS` | `7` | *(new)* |
| `refreshCookie.path` | `REFRESH_COOKIE_PATH` | `/auth` | hardcoded `'/auth'` |
| `refreshCookie.sameSite` | `REFRESH_COOKIE_SAMESITE` | `lax` | `CORS_ORIGINS ? 'none' : 'strict'` |
| `refreshCookie.secure` | — | `true` | unchanged |

Every default either preserves current behaviour or is the value the proxied deployment wants, so
this can ship before the web change without altering how the running system behaves.
