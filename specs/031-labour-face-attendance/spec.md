# Feature Specification: Labour Face Attendance

**Feature Branch**: `031-labour-face-attendance`
**Created**: 2026-10-16
**Status**: Implemented
**Input**: Site supervisors mark daily labour attendance by face photo (punch in and out), labour have no app account; HR sets per-site male/female rates; month-end attendance sheet; site payment sheet for any dates.

Extends feature 013 (labour management).

## Clarifications

### Session 2026-10-16

- Q: How does face punch in/out relate to the existing muster wizard? → A: It **replaces** it. The day's muster is built from the punches.
- Q: How is a day counted? → A: Punch in + punch out = full day; punch in only = half day.
- Q: What does the daily rate depend on? → A: Site × gender only (male/female), effective-dated.
- Q: Which sites can a supervisor work? → A: Only the sites HR assigns them.

## Functional Requirements

- **FR-001** A supervisor registers labour with name and gender (required), father's name and mobile (optional), at an assigned site, with 3–5 face photos in the same request. A photo with no detectable face fails the registration (400 `LABOUR_FACE_NOT_DETECTED`).
- **FR-002** Labour codes (`LAB-0001`, …) come from a per-company counter (`LabourCodeSequence`), never reused, unique under concurrent registration; the counter starts past the highest code already issued.
- **FR-003** A supervisor punches a labour in or out with a photo and GPS fix. A face that does not match the registered template, or a photo with no face, is **always refused** (422 `LABOUR_PUNCH_REFUSED_FACE`) and nothing is written to attendance.
- **FR-004** Location follows the employee punch rule (020): the company's accuracy limit and the site geofence; refused (422 `LABOUR_PUNCH_REFUSED_LOCATION` / `_UNLOCATABLE`) when the company enforces the punch block, otherwise accepted and flagged.
- **FR-005** One punch-in and one punch-out per labour per day; out requires in (409 `LABOUR_NOT_PUNCHED_IN`, `LABOUR_ALREADY_PUNCHED`). The server clock decides the day; punching is online-only.
- **FR-006** Every refused punch is logged (`LabourPunchRefusal`) and listed to the supervisor.
- **FR-007** Accepted punches write one muster roll per site and day (`source = face_punch`, approved), with a half-day line on punch-in upgraded to full day on punch-out, so payment sheets, reports and project costing read them unchanged. Manual muster capture routes are removed; approval of pre-031 musters remains.
- **FR-008** HR (`LABOUR_APPROVE`) assigns sites to every account holding `DAILY_WORKER_REGISTRY` write. A supervisor sees, registers and punches only at assigned sites (403 `LABOUR_SITE_NOT_ASSIGNED`); `LABOUR_APPROVE` and cross-company callers see every site.
- **FR-009** HR sets a male and a female daily rate per site from a date, appended forward; a rate used by an approved payment sheet cannot be corrected.
- **FR-010** A worked day is priced: worker override → site rate for the worker's gender on that date → (pre-031 days) project × skill rate. A missing rate fails sheet generation naming site, gender and date (409 `LABOUR_SITE_RATE_MISSING`; `LABOUR_GENDER_MISSING` for a worker with no gender).
- **FR-011** A payment sheet is generated for one site and a from/to date range; it may not overlap another sheet for the site or a pre-031 project sheet covering it. It downloads as a printable XLSX with a signature column.
- **FR-012** The month-end consolidated attendance sheet (XLSX) lists every labour at the site(s) — one column per day, P (full) / H (half) — with totals, and a second tab of punch times.

## Key Entities

`SiteWageRate`, `SupervisorSite`, `LabourCodeSequence`, `LabourPunch`, `LabourPunchRefusal`; `LabourWorker` gains `fatherName`, `gender` becomes an enum (`male`/`female`, null for unreadable legacy values); `LabourPaymentSheet` gains `siteId`.

## Success Criteria

- **SC-001** e2e `test/labour-attendance.e2e-spec.ts` covers FR-001–FR-012 (23 tests).
- **SC-002** Migration converts existing free-text gender in place (`Male`/`m`/`F`/`female` → enum; anything else → null) and seeds the code counter.
