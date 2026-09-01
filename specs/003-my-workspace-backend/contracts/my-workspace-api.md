# Contract: `/my/*` endpoints

Every endpoint requires an authenticated request (`JwtAuthGuard`, feature 001) and resolves the
caller's own `Employee` record from their `userId` — there is no `employeeId` path/query parameter
anywhere in this contract; an employee can never address another employee's data (spec FR-028).
Admin-side endpoints (exception resolution, leave approval, re-enrolment review) additionally
require the relevant permission (`DAILY_WORKER_REGISTRY` or equivalent, feature 002's `Permission`
enum) and are listed separately below.

## Face Enrolment — `/my/face-enrol`

### `GET /my/face-enrol`
**Response — 200**: `{ status: 'not_enrolled' | 'enrolled' | 're_enrolment_requested',
enrolledAt: string | null }`.

### `POST /my/face-enrol`
**Request**: `{ photos: string[] (3–5, base64/multipart), consentMethod: 'signed_paper' |
'digital' | 'verbal', consentAcknowledged: true }`.

**Response — 201**: `{ status: 'enrolled', enrolledAt: string }`.

**Response — 400**: fewer than 3 photos, `consentAcknowledged !== true`, or no face detected in a
submitted photo (spec Edge Cases).

**Response — 409**: employee already enrolled (must use the re-enrolment flow instead, FR-003).

### `DELETE /my/face-enrol/consent`
Withdraws consent. **Response — 200**: photos/descriptor deleted, `status` reverts to
`not_enrolled`; any pending re-enrolment request is auto-closed (FR-017).

> **UI note (2026-08-31)**: this endpoint is unchanged and still the withdrawal route required by
> FR-004, but the employee-facing Face Enrolment screen no longer surfaces it — see the frontend
> spec's FR-002b (`buildcore-web/specs/003-my-workspace`). Withdrawal is API-level only.

### `POST /my/face-enrol/re-enrolment-request`
**Request**: `{ reason: string }`. **Response — 201**: `{ status:
're_enrolment_requested' }`; notifies HR/Admin.

### `POST /my/face-enrol/re-enrolment-complete`
**Request**: `{ photos: string[] (3–5), consentAcknowledged: true }`.

**Response — 200**: `{ status: 'enrolled', enrolledAt: string }` — old descriptor deleted, new one
active, unlock consumed.

**Response — 403**: no active/unexpired/unconsumed unlock for this employee (FR-013).

## Punch — `/my/punch`

### `POST /my/punch`
**Request**: `{ type: 'in' | 'out', photo: string, latitude: number, longitude: number,
capturedAt: string (ISO 8601) }`. `capturedAt` may precede the request time (offline-sync case,
research.md §4).

**Response — 201**: `{ id, type, capturedAt, isOfflineSync, faceMatchResult: 'matched' |
'exception', geofenceResult: 'in_range' | 'exception' }` — always 201 even when either result is
`exception`; the punch is recorded either way (spec FR-007).

**Response — 400**: no enrolled face template (FR-005); `capturedAt` older than the configured
max offline-queue age (FR-012).

**Response — 409**: the day's punch allowance is already used (FR-008) — a second `type: 'in'` on
a day that already has one (closed or not), a `type: 'out'` with no punch-in that day, or a second
`type: 'out'`. The day is the caller's calendar day in the configured timezone (FR-018a). A punch
queued offline that syncs onto such a day is refused the same way; the recorded punch stands.

**Response — 423 Locked**: `capturedAt`'s date falls within an already payroll-locked period
(FR-010).

### `GET /my/punch/history?month=&year=`
**Response — 200**: `{ days: [{ date, dayOfWeek, inTime, outTime, otHours, status: 'present' |
'absent' | 'on_leave' | 'weekly_off' | 'holiday' }] }` (spec FR-011).

## Admin: Attendance Exceptions (permission-gated, not `/my/*`)

### `GET /workspace-admin/attendance-exceptions?status=pending`
**Response — 200**: list of `PunchRecord`s with `faceMatchResult: 'exception'` or
`geofenceResult: 'exception'` and `exceptionResolution: 'pending'`.

### `POST /workspace-admin/attendance-exceptions/:punchId/resolve`
**Request**: `{ resolution: 'confirmed' | 'rejected' }`.

**Response — 200**: updates `exceptionResolution`, notifies the employee (FR-011a).

## Leave — `/my/leave`

### `GET /my/leave/balance?financialYear=`
**Response — 200**: `[{ leaveType, opening, accrued, used, balance }]` (spec FR-018).

### `GET /my/leave/applications`
**Response — 200**: the caller's own applications (spec FR-022).

### `POST /my/leave/applications`
**Request**: `{ leaveType, fromDate, toDate, reason }`.

**Response — 201**: the created application, `status: 'pending'`, `dayCount` computed
server-side excluding weekends/site holidays (FR-019).

**Response — 400**: computed `dayCount` exceeds available balance for a non-LWP type (FR-020).

**Response — 423 Locked**: date range falls within an already payroll-locked period (FR-010).

### `POST /my/leave/applications/:id/cancel`
**Response — 200**: `status: 'cancelled'`.

**Response — 409**: application is not currently `pending` (FR-021).

## Admin: Leave Approval (permission-gated, not `/my/*`)

### `GET /workspace-admin/leave-applications?status=pending`
**Response — 200**: list of pending applications across the admin's scoped company/sites.

### `POST /workspace-admin/leave-applications/:id/decide`
**Request**: `{ decision: 'approved' | 'rejected', remarks?: string }` — `remarks` required when
`decision: 'rejected'`.

**Response — 200**: updates status, notifies the employee (FR-022a); an `approved` decision makes
the covered dates show `on_leave` in that employee's `GET /my/punch/history`.

## Salary — `/my/salary`

### `GET /my/salary/available-periods`
**Response — 200**: `string[]` of periods (e.g. `"2026-07"`) whose `PayrollRun.status` is
`processed` or `paid` (spec FR-024).

### `GET /my/salary/:period`
**Response — 200**: the `SalarySlip` projection (data-model.md).

**Response — 404**: period not `processed`/`paid`, or no slip exists for it.

### `GET /my/salary/:period/pdf`
**Response — 200**: `application/pdf`, generated via `pdfkit` (research.md §7), identical figures
to the JSON response.

### `GET /my/punch/open`
The caller's punch state for **today**, in the configured timezone (FR-008b).

**Response — 200**:
`{ punchedInAt: string | null, punchedOutAt: string | null, isComplete: boolean }`.

- `punchedInAt` null → the day's punch-in has not been made; punch-in is the available action.
- `punchedInAt` set, `punchedOutAt` null → the shift is open; punch-out is the available action.
- `isComplete` true → both are done and no further punch is accepted today (FR-008).

An open punch-in carried over from an earlier day is deliberately **not** reported here: it can
never be closed (FR-008a) and does not affect what the employee can do today.

## Reimbursements — `/my/reimbursements`

### `GET /my/reimbursements/categories`
The active categories the caller's company allows claims against (FR-029a).

**Response — 200**: `[{ id, code, name, receiptRequiredAbove: number | null }]`. `null` means a
receipt is never required for that category — distinct from `0`, which requires one on every claim.

Read-only here; feature 005 owns creating and editing these. Declared ahead of any parameterised
`GET` on this controller so a future `/:id` route cannot swallow it.

### `POST /my/reimbursements`
**Request**: `{ categoryId, amount, expenseDate, description, receiptRef?, receipt?, status? }`.
A receipt is required when `amount` exceeds the category's configured mandatory-receipt threshold
(FR-030), satisfied by either field.

`receipt` is base64 image data (optionally a data URL), stored server-side **in this same request**
and turned into `receiptRef` (FR-029b) — deliberately not a separate upload endpoint, which would
orphan a blob for every claim the employee then abandons. It is normalised on the way in, which
strips EXIF including GPS. `receiptRef` remains for a caller that already holds a stored reference;
`receipt` wins if both are sent.

`status` is `draft` or `submitted` (default `submitted`); a draft stays editable and skips the
receipt rule until it is submitted.

**Response — 201**: the created claim.

### `PATCH /my/reimbursements/:id`
**Request**: same shape as create, all fields optional. Sending `status: 'submitted'` is how a
draft is submitted without otherwise editing it.

The receipt rule is re-checked against the values the claim will *end up* with, not the ones this
request happened to carry — so a draft saved under the threshold and later submitted above it is
still refused (FR-030).

**Response — 200** while `status: 'draft'`; **409** otherwise.

### `POST /my/reimbursements/:id/withdraw`
**Response — 200** while `status: 'submitted'` (still Pending review); **403** otherwise.

### `GET /my/reimbursements`
**Response — 200**: the caller's own claims, with status and, once processed, `paymentMode`.

## Audit logging (cross-cutting, not a separate endpoint)

Every enrolment, punch (including exceptions and their resolution), leave application/cancellation/
decision, and re-enrolment lifecycle event writes one `AuditLogEntry` via the shared
`AuditLogService` (data-model.md cross-reference table) — this feature never exposes a way to read
it back, matching feature 001/002's write-only posture for that table.
