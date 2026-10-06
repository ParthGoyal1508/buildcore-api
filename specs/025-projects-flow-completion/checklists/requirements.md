# Specification Quality Checklist: Projects Flow Completion

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs)
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] Success criteria are technology-agnostic (no implementation details)
- [X] All acceptance scenarios are defined
- [X] Edge cases are identified
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [X] Feature meets measurable outcomes defined in Success Criteria
- [X] No implementation details leak into specification

## Notes

Three judgements made rather than marked for clarification, each recorded in Assumptions:

1. **Which side converts the retention percentage.** The subcontract retention term already in the
   system is stored as a fraction and converted by the screen that collects it. The spec follows
   that convention rather than introducing a second one, because the same composer reads both.
2. **What clearing a programme field means.** Omission leaves a field unchanged; an explicit empty
   value clears it. Without the distinction a wrong finish date cannot be removed.
3. **Which artifact is authoritative when a client and a service disagree.** The published contract
   and its tested implementation. FR-008 turns this from a principle into a check.

**FR-025 through FR-034 are deliberately phrased as reachability, not capability.** Every one names
behaviour that already exists on the server. A reader implementing them who writes a service is
implementing the wrong thing.
