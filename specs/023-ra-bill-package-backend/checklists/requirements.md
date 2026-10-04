# Specification Quality Checklist: Running-Account Bill Package

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
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

**All three [NEEDS CLARIFICATION] markers are resolved.** Put to the user on 2026-10-05 and
answered: the cumulative position is frozen at issue (D1), a claim may exceed the approved
measurement with a reason and a flag (D2), and provenance is the period rather than a recorded link
(D3). The reasoning and the rejected options are in the spec's Decisions section.

**Five requirements were added that no question asked for**, because each answer created an
obligation the question did not mention — and these are the items a reviewer should look hardest at:

- **FR-014b** exists because freezing the cumulative position makes it possible for a late-approved
  report to belong to an already-billed period. Freezing without requiring the understatement to be
  reportable would trade a reconciliation problem for a silent revenue leak, which is worse.
- **FR-006a** exists because the stated risk of permitting over-claims is that the reason field
  becomes the route around the control. The mitigation is visibility rather than a stricter rule: the
  flag is countable per bill and per project, because a reason nobody aggregates is a reason nobody
  reads.
- **FR-049a** closes 022 FR-020a explicitly — 022's reversal guard stays a quantity floor and is not
  tightened — so the question is not left open in two features at once.
- **FR-049b** and **FR-014a** carry the remaining consequences: the one case the period cannot
  answer, and the storage that makes every bill reproducible from itself.

**Deliberate deviations from "no implementation details", consistent with features 008, 018 and 022.**
The specification is written in domain language throughout — *the two half-rate taxes* rather than
CGST and SGST, *the issuing party's position* rather than a column name — but it names existing
tables in Assumptions where the point is what the current schema cannot hold, and FR-050 speaks about
database roles because the constitution requires the isolation proof and a non-technical phrasing
would not say the thing that matters: that a policy tested under a superuser has not been tested.

**One success criterion quotes the client's own figures on purpose.** SC-003 names 18,41,686 →
1,65,752 / 1,65,752 / 92,084 / 36,834 / 11,39,971. Reproducing a real document's arithmetic is a
sharper test than asserting that percentages are applied, because it catches a rate applied to the
wrong base — which is the error that would otherwise survive every unit test.
