# Specification Quality Checklist: Project Schedule & Progress

**Purpose**: Validate completeness before planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs)
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

## Requirement Completeness

- [ ] **No [NEEDS CLARIFICATION] markers remain** — three remain, deliberately. FR-022, FR-023 and
      FR-024 are decisions about how this organisation plans work, not about software, and guessing
      any of them would produce a programme that computes a confident wrong number. They are the
      first thing `/speckit-clarify` should ask.
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] Success criteria are technology-agnostic
- [X] All acceptance scenarios are defined
- [X] Edge cases are identified
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [ ] **Not ready to plan** until the three clarifications are answered. FR-022 in particular
      decides the shape of the data: weighting by value, by quantity or by hand are three different
      columns and three different refusals.

## Notes

Written at the end of feature 025 rather than when the work starts, because 025's audit is what
established the boundary: a BOQ line now carries its own programme, so this feature's first job is
to say how an activity relates to one (FR-003) rather than to re-plan the same dates one level up.

**Nothing here is built.** 008's TA001–TA020 remain unchecked and this document is what they become.
