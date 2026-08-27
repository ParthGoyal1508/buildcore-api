# Data Model: HR & Payroll Backend (Employees, Attendance, Leave, Payroll, Challans, Loans, Daily Workers)

Field names are conceptual; exact Prisma types are a task-level decision. See research.md for
schema placement and how each entity relates to features 001–004.

## Employee (`hr` schema — MODIFIES feature 003's minimal model)

Unchanged from 003: `id`, `userId`, `companyId`, `siteId`, `shiftId`, `employeeCode`.

**New fields, grouped by the PRD's tabs:**

| Group | Fields |
|---|---|
| Identity | `firstName`, `lastName`, `title`, `dob`, `gender`, `maritalStatus`, `photoRef` |
| Employment | `departmentId`, `designationId` (both FK to `settings.Department`/`Designation`, 002), `employmentType` (`full_time`\|`contract`\|`daily_wage`), `dateOfJoining`, `probationEndDate`, `confirmationDate`, `reportingToEmployeeId`, `musterCategory`, `hoursPerDay`, `dailyRate`, `payMode`, `calculationMode` (`monthly`\|`daily`), `workmanId`, `isActive` |
| Statutory | `pfApplicable`, `pfUpperLimit` (bool), `esicApplicable`, `esicUpperLimit` (bool), `uan`, `pfNumber`, `esicNumber`, `aadhaarEncrypted`, `panEncrypted` (research.md §3) |
| Pay & Bank | `basic`, `hra`, `conveyanceAllowance`, `siteAllowance`, `specialAllowance`, `paymentMode`, `bankName`, `bankBranch`, `bankAccountNumberEncrypted`, `ifscCode` |
| Contact | `mobile`, `alternateMobile`, `email`, `presentAddress` (address/city/state/pin), `permanentAddress`, `emergencyContactName`, `emergencyContactRelation`, `emergencyContactPhone` |
| Letters | `offerLetterIssued`+`Date`, `appointmentLetterIssued`+`Date`, `ndaSigned`+`Date` |
| Onboarding | 7 boolean checklist items: `idCardIssued`, `uniformProvided`, `safetyInductionCompleted`, `toolsIssued`, `bankVerificationDone`, `biometricEnrolled`, `siteAccessGranted` |

## Employee Document (`hr` schema — new)

`{ id, employeeId, documentTypeId (FK settings.DocumentType, 002), fileRef (encrypted
object-storage reference), documentNumber?, expiresAt?, uploadedAt }`. Deletion not modeled — a
re-upload replaces the reference for that type; historical replacement isn't separately versioned
(not required by the PRD).

## Employee Transfer (`hr` schema — new)

`{ id, employeeId, fromCompanyId, toCompanyId, transferDate, reason, codeRetained: boolean,
newEmployeeCode?, transferredByUserId, createdAt }`.

## Holiday (`hr` schema — new; supersedes `Site.holidays`, research.md §6)

`{ id, companyId, name, date, type: 'national' | 'regional' | 'company', appliesToAllSites:
boolean }`, plus a `HolidaySite` join table when `appliesToAllSites = false`.

## Attendance record (`hr` schema — MODIFIES feature 003's `PunchRecord`-derived representation)

Adds: `adminEdited: boolean`, `editedByUserId?`, `editedAt?`, `statusOverride?`, `remarks?` to the
existing per-day attendance representation research.md §7 describes.

## Attendance Modification (`hr` schema — new)

`{ id, employeeId, date, actorUserId, before: JSON, after: JSON, timestamp }` — append-only.

## Payroll Run (`payroll` schema — MODIFIES feature 003's status-only stub)

Unchanged from 003: `companyId`, `period`, `status` (`draft`\|`processed`\|`paid`). New:
`generatedAt`, `generatedByUserId`, `processedAt`, `paidAt`.

## Payroll Line Item (`payroll` schema — new)

`{ id, payrollRunId, employeeId, monthDays, payableDays, lopDays, otHours, otWages, basic, hra,
conveyanceAllowance, siteAllowance, specialAllowance, employeePf, employeeEsic,
professionalTax, tds (manual entry, default 0 — clarification), loanEmiDeduction, netPay,
employerPf, employerEps, employerEdli, adminCharges, employerEsic, gratuity, bonus }` — the
source of truth `/hr/challans/*` (research.md §5) and 003's `/my/salary` both read from.

## Loan (`payroll` schema — new)

`{ id, employeeId, amount, emiAmount, disbursementDate, reason, remarks?, status: 'active' |
'closed' | 'pending' }`.

## Loan Schedule Entry (`payroll` schema — new)

`{ id, loanId, month, emiAmount, principal, interest, remainingBalance, status: 'paid' |
'upcoming' | 'overdue', paidInPayrollRunId? }`.

## Daily Worker (`hr` schema — new, structurally independent of Employee — research.md §8)

`{ id, companyId, siteId, workerIdCode (auto-generated), name, phone?, gender, trade,
dailyWageRate, descriptor (encrypted, same derivation as FaceEnrolment), photoRefs,
consentAttestedByUserId, consentAttestedAt, enrolledByUserId, enrolledAt, status: 'active' |
'inactive' | 'converted', convertedToEmployeeId? }`.

## Daily Worker Attendance (`hr` schema — new)

`{ id, dailyWorkerId, date, photoRef?, latitude?, longitude?, markedByUserId, markedAt, status:
'present' | 'absent', markingMethod: 'face_match' | 'manual', exceptionNote? }`.

## Company (`settings` schema — MODIFIES feature 002's model, per clarification)

New field: `otMultiplier` (decimal, default 2.00) — FR-014a, alongside 002's existing
`pfEmployerRate`/`esicEmployerRate`/`gratuityRate`/`bonusRate`.

## Cross-reference to features 001–004

| Concept | Relationship |
|---|---|
| `Employee` (003) | Extended in place (§2 above) — no redefinition |
| `Site.holidays` (003) | Dropped, replaced by `Holiday` (§6/research.md §6) |
| `PunchRecord`/attendance status computation (003) | Extended with admin-edit fields; status computation now reads `Holiday` instead of `Site.holidays` |
| `LeaveApplication`/`LeaveBalance` (003) | Unchanged — this feature adds only an admin list endpoint (FR-012/FR-013), no schema change |
| `PayrollRun` (003) | Extended from status-only to carry real `PayrollLineItem`s |
| `ReEnrolmentRequest` (003) | Unchanged — this feature adds only an admin list endpoint (FR-029) |
| `BiometricsService` (003) | Reused, not reimplemented, for Daily Worker enrolment/matching |
| `Department`/`Designation`/`DocumentType`/`Shift`/employee-code-series (002) | Read via `settings`' exported services; `EmployeeDocument` FKs `DocumentType` |
| `Permission` enum (002) | Reused verbatim (`EMPLOYEES`/`ATTENDANCE`/`PAYROLL`/`CHALLANS`/`LOANS`/`DAILY_WORKER_REGISTRY`) — no new values |
| Dashboard widget/notification providers (004) | This feature's Document Expiry data, PF/ESIC-pending challan counts, and site headcount aggregates are what let 004's currently-placeholder providers for those become real (a 004 task, not this feature's own scope) |
