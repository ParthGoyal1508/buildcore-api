# Data Model: Per-Employee Geofence and Punch Refusal (020, User Story 3)

Scope: User Story 3 only. Fuel accountability's entities (Fuel Exception, Hire Deduction, Operator
Recovery) are modelled when `bugs.md` item 13 reaches its batch.

Two new tables, one new column, and one enum deliberately left alone.

---

## New: `PunchRefusal` — `hr`

A punch that was refused. **Not attendance** — that is the entire point of the table existing
separately (research §1, FR-013a, FR-013c).

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | RLS key |
| `employeeId` | `String` | |
| `employee` | `Employee @relation(...)` | |
| `attemptedAt` | `DateTime` | When the punch was taken (the client's `capturedAt`) |
| `receivedAt` | `DateTime @default(now())` | When the server saw it — an offline-queued refusal separates these |
| `punchDay` | `DateTime @db.Date` | The business-timezone day, stamped as `PunchRecord` does it, so "how many refusals on the 14th" is answerable |
| `type` | `PunchType` | In or out. Reused enum — a refusal is a refusal of a specific act |
| `reason` | `PunchRefusalReason` | Which check refused it. See enum below |
| `latitude` | `Float` | Where the device said it was |
| `longitude` | `Float` | |
| `accuracyMeters` | `Float?` | What the device claimed. Null for a client that does not send it |
| `distanceMeters` | `Float?` | Distance from the fence centre. Null for a face refusal, where it was never computed |
| `faceMatchDistance` | `Float?` | Null for a location refusal. **Not** the photo — see below |

**Indexes**: `@@index([companyId, punchDay])` for the operational "how many today" question,
`@@index([employeeId, punchDay])` for an employee's own list and for the impersonation-pattern read.
`@@schema("hr")`.

**RLS**: `ENABLE` + `FORCE` with a `tenant_isolation` policy in hand-authored SQL, proved with the
`NOSUPERUSER NOBYPASSRLS` probe role.

> **No photo column, deliberately.** A face-mismatch refusal means the system could not establish
> whose face it is, and keeping an unattributed biometric image against a named employee is a worse
> privacy position than the attendance row it replaces. Plan D20 and research §4 carry the argument.
> `faceMatchDistance` is kept because a number is not a biometric.

> **This table must never grow a decision.** No `resolvedBy`, no `status`, no `approvedAt`. FR-013c
> says a log and not a reviewable item, and the failure mode is accretion: one "resolve" action and
> this becomes the exception queue the client replaced. The e2e asserts no route promotes a refusal to
> attendance.

---

## New: `enum PunchRefusalReason` — `hr`

| Value | Meaning |
|---|---|
| `outside_fence` | The fix was locatable and outside the fence, allowance applied |
| `unlocatable` | Reported accuracy exceeded the company's configured maximum |
| `face_mismatch` | A face was detected and did not match the enrolment |
| `face_undetectable` | No face could be detected in the photo at all |

`face_mismatch` and `face_undetectable` are separated because they mean different things about the
person holding the phone — one is a possible impersonation, the other is dust, a helmet or bad light.
The refusal the employee sees collapses them (D18 returns `PUNCH_REFUSED_FACE` for both, since the
advice is the same: retake the photo); the log does not, because the pattern worth detecting differs.

---

## New: `EmployeeLocationAssignment` — `hr`

The location an employee's punches validate against, and its history (FR-011, FR-014).

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | |
| `employeeId` | `String` | |
| `siteId` | `String?` | The site whose fence applies. Null **only** when `isMobile` is true |
| `isMobile` | `Boolean @default(false)` | FR-014's exemption. On the assignment, not on `Employee`, so exempting someone is a dated attributable act |
| `effectiveFrom` | `DateTime @db.Date` | Resolution keys on this (research §5) |
| `assignedByUserId` | `String` | FR-011's author |
| `reason` | `String?` | Why, where stated — a mobile exemption without one is unreviewable |
| `createdAt` | `DateTime @default(now())` | |

**Indexes**: `@@index([employeeId, effectiveFrom])` — the resolution query's access path, and the only
way this table is read on the punch path. `@@schema("hr")`.

**RLS**: as above.

**Resolution rule**: the row with the greatest `effectiveFrom` at or before the punch's `punchDay`.
No row at all → fall back to the site geofence, which is today's behaviour and FR-016's requirement.
Keyed on the punch's day rather than the request time so an offline-queued punch validates against the
assignment in force when it was taken.

> **A check constraint enforces `siteId IS NOT NULL OR isMobile`.** An assignment that names no site
> and claims no exemption is a row that validates nothing, and the reader who meets it cannot tell
> whether it is an exemption or an unfinished edit.

---

## Changed: `Company` — `settings`

| Field | Type | Notes |
|---|---|---|
| `punchAccuracyMaxMetres` | `Int?` | The FR-012b setting. Null = use the configured default (50). Written under `COMPANY_SETTINGS` |

Nullable rather than defaulted-in-the-database on purpose: null means *"this company has not decided"*,
which is a different fact from *"this company chose 50"*, and only the first should silently follow a
change to the product default. Read by `hr` through `CompaniesService` in the same method that already
calls `getPayrollLockDay`, so no new cross-module reach (Principle I).

---

## Unchanged: `PunchRecord`, `FaceMatchResult`, `GeofenceResult`

**No new column, no new state, and the `exception` enum values stay.**

This is a decision, not an omission. Historical rows carry `faceMatchResult: exception` and
`geofenceResult: exception` legitimately — they were real punches, accepted under the behaviour in
force when they were taken, and some are still referenced by payroll periods already paid. A migration
that removed the enum value would destroy real history to tidy a vocabulary.

New rows simply never take those values, because a punch that would have produced one is now refused
before the insert.

> The comment at `punch.service.ts:257` — *"Neither check can reject the punch; both can flag it"* —
> becomes false with this change and must be rewritten in the same commit. It is the first thing a
> reader of that method learns, and a comment asserting the opposite of the code is worse than none.
