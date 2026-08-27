# Quickstart: Validating the My Workspace Backend

## Prerequisites

- Local Postgres with migrations applied (`hr`/`projects`/`payroll` schema additions, `shared`
  `AuditLogEntry` extension — data-model.md).
- A seeded company (feature 002), a seeded Site with a known geofence center/radius and at least
  one holiday, a seeded Shift, and one Employee linked to a `shared.User` account with a valid
  access token.
- Test photos: one clear face photo (for enrolment + a matching punch) and one different/no-face
  photo (for a face-verification exception).
- GPS coordinate pairs: one inside the seeded Site's geofence radius, one clearly outside it.

## Scenario 1 — Face enrolment (User Story 1)

1. `GET /my/face-enrol`. **Expected**: `{ status: 'not_enrolled' }`.
2. `POST /my/face-enrol` with 2 photos. **Expected**: 400 (below minimum 3).
3. `POST /my/face-enrol` with 3 valid photos, a `consentMethod`, `consentAcknowledged: true`.
   **Expected**: 201, `status: 'enrolled'`.
4. Repeat step 3. **Expected**: 409 (already enrolled — re-enrolment flow required instead).
5. `DELETE /my/face-enrol/consent`. **Expected**: 200; `GET /my/face-enrol` now shows
   `not_enrolled`.

## Scenario 2 — Punch in/out with face + geofence validation (User Story 2)

1. Re-enrol (Scenario 1). `POST /my/punch` with `type: 'in'`, the matching photo, in-geofence
   coordinates, `capturedAt: now`. **Expected**: 201, `faceMatchResult: 'matched'`,
   `geofenceResult: 'in_range'`.
2. `POST /my/punch` again with `type: 'in'`. **Expected**: 400 (open punch-in already exists).
3. `POST /my/punch` with `type: 'out'`, matching photo, in-geofence coordinates. **Expected**: 201;
   `GET /my/punch/history?month=&year=` for today shows worked hours and `status: 'present'`.
4. Repeat step 1–3 using the out-of-geofence coordinates. **Expected**: punch still recorded (201),
   `geofenceResult: 'exception'`.
5. Repeat using the non-matching/no-face photo. **Expected**: punch still recorded (201),
   `faceMatchResult: 'exception'`.
6. As an admin, `GET /workspace-admin/attendance-exceptions?status=pending`. **Expected**: the two
   exception punches from steps 4–5 appear; `POST .../resolve` with `confirmed` on one.
   **Expected**: 200; that punch no longer appears in the pending list.
7. Attempt a punch with `capturedAt` inside an already payroll-locked period (mark a `PayrollRun`
   `processed` for the test period first). **Expected**: 423.

## Scenario 3 — Offline-synced punch (User Story 6)

1. `POST /my/punch` with `capturedAt` set 2 hours before the request's actual send time.
   **Expected**: 201, `isOfflineSync: true`, and the attendance history entry for that date uses
   the declared `capturedAt`, not the request's arrival time.
2. Repeat with `capturedAt` older than the configured max offline-queue age. **Expected**: 400.

## Scenario 4 — Leave application and approval (User Story 4)

1. `GET /my/leave/balance?financialYear=2026-27`. **Expected**: seeded balances for all four types.
2. `POST /my/leave/applications` with a date range within balance, excluding a seeded weekend/
   holiday. **Expected**: 201, `dayCount` excludes those dates, `status: 'pending'`.
3. `POST /my/leave/applications` with a date range whose computed days exceed Casual Leave balance.
   **Expected**: 400.
4. `POST /my/leave/applications` with `leaveType: 'lwp'` far exceeding any balance figure.
   **Expected**: 201 (LWP never balance-checked).
5. `POST /my/leave/applications/:id/cancel` on the step-2 application. **Expected**: 200,
   `status: 'cancelled'`; repeating cancel now. **Expected**: 409.
6. Submit a new pending application; as admin, `POST /workspace-admin/leave-applications/:id/decide`
   with `decision: 'approved'`. **Expected**: 200; `GET /my/punch/history` for the covered dates
   now shows `status: 'on_leave'`.

## Scenario 5 — Salary slip (User Story 5)

1. Seed one `PayrollRun` `draft` and one `processed` for the employee's company.
   `GET /my/salary/available-periods`. **Expected**: only the `processed` period listed.
2. `GET /my/salary/:processedPeriod`. **Expected**: full slip projection.
3. `GET /my/salary/:processedPeriod/pdf`. **Expected**: `application/pdf`, matching figures.
4. `GET /my/salary/:draftPeriod`. **Expected**: 404.

## Scenario 6 — Re-enrolment (User Story 7)

1. With an enrolled employee, `POST /my/face-enrol/re-enrolment-complete` (no prior request).
   **Expected**: 403 (no active unlock).
2. `POST /my/face-enrol/re-enrolment-request` with a reason. **Expected**: 201,
   `status: 're_enrolment_requested'`; admin notification raised.
3. As admin, approve the request. **Expected**: unlock granted (`unlockExpiresAt` ~7 days out).
4. `POST /my/face-enrol/re-enrolment-complete` with 3 fresh photos + consent. **Expected**: 200,
   new `enrolledAt`; the unlock is now consumed — repeating step 4 immediately. **Expected**: 403.
5. Approve a fresh request, then wait (or manipulate `unlockExpiresAt` in test data) past 7 days
   before completing. **Expected**: 403 (expired).

## Scenario 7 — Audit logging (NFR)

1. Perform one action from each of Scenarios 1–6 above (enrol, punch + exception resolve, leave
   apply + decide, re-enrolment full cycle).
2. Inspect `AuditLogEntry` directly. **Expected**: one entry per action with the correct
   `entityType`, actor, timestamp, and company.
