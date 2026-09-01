# Data Model: Recruitment & Onboarding Backend

**Feature**: `011-recruitment-onboarding-backend` | **Date**: 2026-09-01

Schemas: `recruitment` (11 tables), `settings` (2 new reference-data tables). Every table carries
`companyId` with RLS (FR-001). All tables carry `createdAt`, `updatedAt`, `createdBy`, and — where
soft-delete applies (FR-036) — `deletedAt` and `deletedBy`.

## `settings` schema additions

### KitItem (FR-037)
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| companyId | uuid | RLS |
| name | string | unique per company |
| linkedInventoryItemId | uuid? | optional; inert until 009 is built |
| defaultQuantity | int | default 1 |
| issuedByDefault | bool | seeds the onboarding checklist |
| isRecoverableAtExit | bool | surfaces at F&F |
| isActive | bool | |

### LetterTemplate (FR-020, FR-021)
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| companyId | uuid | RLS |
| letterType | enum | offer \| appointment \| confirmation \| relieving \| experience |
| name | string | |
| bodyTemplate | text | `{{token}}` substitution; tokens validated against the type's documented set at save |
| letterheadAssetId | uuid? | optional |
| isActive | bool | **at most one active per (companyId, letterType)** — enforced by partial unique index |

## `recruitment` schema

### Requisition
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| companyId | uuid | RLS |
| requisitionCode | string | auto-generated via Settings code series (FR-002); unique per company |
| departmentId, designationId | uuid | → `settings` |
| positionCount | int | > 0 |
| filledPositions | int | derived, incremented in the joining transaction (FR-013) |
| employmentType | enum | permanent \| contract \| walk_in |
| projectId?, siteId? | uuid | → `projects` via ProjectsService |
| targetJoiningDate | date | |
| budgetedCtcMin, budgetedCtcMax | decimal | drives the outside-budget flag (FR-011) |
| justification | text | |
| status | enum | draft \| pending_approval \| open \| rejected \| closed |
| approvedBy, approvedAt, rejectionReason | | |

Constraints: auto-close when `filledPositions == positionCount` (FR-014); delete blocked when
candidates exist (→ 409).

### Candidate
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| companyId | uuid | RLS |
| requisitionId | uuid | FK, required — a candidate always belongs to one (FR-003) |
| fullName | string | |
| phone, email | string | **masked in lists** (FR-006); unique among non-rejected/non-no-show per company (FR-007) |
| totalExperienceYears | decimal | |
| currentEmployer | string? | |
| currentCtc, expectedCtc | decimal? | **masked in lists** (FR-006) |
| source | enum | referral \| agency \| walk_in \| portal \| internal |
| referredByEmployeeId | uuid? | → `hr` via HrService |
| resumeRef | string? | encrypted object-storage reference (FR-024) |
| stage | enum | applied \| shortlisted \| interviewing \| selected \| offer_issued \| offer_accepted \| joined \| rejected \| no_show |
| employeeId | uuid? | set on joining; never deleted (FR-013) |
| previousCandidateId | uuid? | links a re-application to the prior record |
| rejectionReason | text? | |

Constraints: stage transitions restricted to the FR-004 machine, applied under a row-level lock
(FR-034).

### CandidateStageHistory (FR-005) — **immutable**
`id`, `companyId`, `candidateId`, `fromStage`, `toStage`, `actorId`, `occurredAt`, `remarks?`.
Source of truth for time-to-hire (FR-028).

### Interview
`id`, `companyId`, `candidateId`, `roundNumber` (unique per candidate), `roundType`
(telephonic|technical|hr|managerial|final), `scheduledAt`, `mode` (in_person|phone|video),
`location?`, `status` (scheduled|completed|cancelled), `rescheduleCount`, `rescheduleHistory` (jsonb).

### InterviewInterviewer
Join table: `interviewId`, `employeeId`. Gates who may submit feedback (FR-009).

### InterviewFeedback (FR-009)
`id`, `companyId`, `interviewId`, `interviewerEmployeeId`, `outcome` (recommend|hold|reject),
`score` (1–10), `comments`, `submittedAt`. One row per interviewer per interview.

### Offer
| Field | Type | Notes |
|---|---|---|
| id, companyId, candidateId | | |
| designationId, departmentId | uuid | |
| offeredCtc | decimal | |
| salaryBreakup | jsonb | component name + monthly amount; sum must equal `offeredCtc / 12` within tolerance (FR-010) |
| proposedJoiningDate, confirmedJoiningDate? | date | |
| probationMonths, noticePeriodDays | int | |
| reportingManagerEmployeeId | uuid | |
| outsideBudget | bool | set when > requisition `budgetedCtcMax` (FR-011) |
| status | enum | draft \| issued \| accepted \| declined \| superseded |
| letterId | uuid? | → GeneratedLetter |
| acceptedOn?, declineReason? | | |

Constraints: immutable once `accepted` (FR-012); at most one non-superseded offer per candidate.

### OnboardingChecklist / OnboardingItem (FR-015 to FR-019)
Checklist: `id`, `companyId`, `employeeId`, `candidateId`, `openedAt`, `completedAt?`.
Item: `id`, `checklistId`, `itemType` (document|kit|induction), `documentTypeId?`, `kitItemId?`,
`status` (pending|completed|waived), `completedBy?`, `completedAt?`, `waiverReason?`,
`linkedIssueId?` (set when a kit item resolves to an inventory issue — FR-018).

### GeneratedLetter (FR-022)
`id`, `companyId`, `letterType`, `employeeId?`, `candidateId?`, `templateId`, `renderedRef`
(encrypted object storage), `version`, `isSuperseded`, `issuedAt`, `issuedBy`. **Immutable once
issued**; regeneration creates the next version.

### Resignation (FR-025, FR-026)
`id`, `companyId`, `employeeId`, `resignationDate`, `reasonCategory` (better_opportunity|personal|
relocation|health|compensation|work_environment|other), `reasonDetail`, `noticePeriodDays`,
`expectedLastWorkingDay` (computed), `agreedLastWorkingDay?`, `noticeWaiverDays?`, `waiverReason?`,
`status` (submitted|accepted|withdrawn), `withdrawReason?`.

Constraints: rejected for an inactive employee; one non-withdrawn resignation per employee (→ 409).

## Cross-module reads (no cross-schema queries — Principle I)

| Need | Path |
|---|---|
| Create the Employee on joining | `HrService` (FR-013) |
| Store a verified document | 005's employee-document surface (FR-016) |
| Mandatory document types | `SettingsService` (002 FR-019) |
| Employee code series | `SettingsService` (002 FR-023) |
| Kit issue → inventory | `InventoryService` (FR-018) |
| F&F processed check for relieving letters | `PayrollService` (FR-023) |

## Exported service methods

- `getAcceptedResignation(employeeId)` — consumed by 005 FR-065.
- `generateLetter(employeeId, letterType)` — consumed by 005's F&F flow for relieving letters.
