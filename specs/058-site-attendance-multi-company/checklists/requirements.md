# Specification Quality Checklist: Refusals for Super Admin, site-tagged staff attendance, multi-company access

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-06
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

- The spec names existing product concepts (Super Admin as the cross-company permission, hard block, mobile assignment) because the user decisions are phrased in them. It names no code, tables or endpoints.
- Informed defaults are recorded under Assumptions rather than as markers: "all companies" is set per role (as the client sheet does it); a project assignment includes sites added later; overlapping fences go to the nearest centre; old punches are backfilled only where the site is certain. Raise any of these in `/speckit-clarify` if they are wrong.
