# Specification Quality Checklist: Daily Work Reports

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

Two items need stating plainly rather than ticking quietly.

**Both [NEEDS CLARIFICATION] markers are resolved.** They were put to the user on 2026-10-04 and
answered: a presence-based day's quantity is entered directly in a field of its own (FR-030,
FR-030a to FR-030c), and approval is a direct transition in which the approver may not be the
author (FR-012a). The reasoning for each, including the options rejected and why, is recorded in
the spec's Decisions section rather than lost to the conversation that produced it.

**"No implementation details" passes against this repository's house style, not against a strict
reading.** The specification names existing tables, columns and modules — `plant.LogbookEntry`,
`Site` carrying no code field, the done-quantity counter — and FR-040 speaks about database roles
and row-level security. This matches features 008 and 018, whose specifications anchor requirements
to the entities already in the schema, and it is load-bearing here: three of the four findings this
feature exists to settle are *about* what the existing schema can and cannot hold. FR-040 is
retained in technical terms because the constitution requires the isolation proof and because a
non-technical phrasing of it would not say the thing that matters — that a policy tested under a
superuser has not been tested.

**SC-008 was rewritten during validation.** Its first form read "without the approval taking longer
than a user will wait for a single confirmation", which is not measurable. It now names three
seconds per step and two seconds for a month's listing.

**One requirement was added that no question asked for.** FR-030b forbids reading the six factors
for a presence-based line. It exists because the factors all default to 1, so their product is 1 —
indistinguishable from "one day served" — and a quantity that is correct by coincidence is the
kind of thing that passes every test until somebody sets a factor.
