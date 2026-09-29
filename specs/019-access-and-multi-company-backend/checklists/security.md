# Requirements Quality Checklist: access, scoping and cash visibility

**Purpose**: Validate the quality of the requirements in the three places where a requirements gap in
this feature becomes a security gap — the read/write permission model, company scoping, and cash
visibility. Reviewer-owned.

**Created**: 2026-09-29
**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

**What `[x]` means here**: the reviewer has determined the *requirement* is complete, clear,
consistent and measurable. It does **not** mean the behaviour is built or tested. `/speckit-implement`
reads this file's state and does not modify these markers.

**Not duplicated here**: `checklists/requirements.md` covers general specification quality for this
feature. This file covers only the three security-adjacent domains.

## Requirement Completeness — the permission model

- [ ] CHK001 Are requirements defined for what happens to a role holding **write without read** on an area? [Spec §Edge Cases asks the question; no FR answers it]
- [ ] CHK002 Is the set of "module areas" FR-002 grants access within actually enumerated anywhere, or only exemplified by Note 22's logbook case? [Gap, Spec §FR-002]
- [ ] CHK003 Are requirements defined for an area a role holds at **neither** level, as distinct from an area held at read? [Completeness — the two produce different refusals per contracts, but no FR distinguishes them]
- [ ] CHK004 Does any requirement state whether the level distinction applies to **approval** permissions (`INVENTORY_APPROVE`, `LABOUR_APPROVE`, `RECRUITMENT_APPROVE`, `ASSETS_APPROVE`)? [Gap — a read/write level over an approval right is either meaningless or a third concept]
- [ ] CHK005 Are requirements defined for endpoints that **declare no permission at all**? FR-005 requires refusing direct access, but 28 routes declare nothing and 6 of them are not self-service. [Gap, Spec §FR-005]
- [ ] CHK006 Is there a requirement covering how a **new** endpoint added after this feature acquires a permission, so FR-005 holds for code not yet written? [Gap — otherwise FR-005 is true on the day it ships and decays]
- [ ] CHK007 Are requirements defined for the **retention** of the refusal record FR-003 mandates? [Gap — a security log with no stated lifetime]
- [ ] CHK008 Does FR-003's "record the refusal" specify what must be recorded, or only that something is? [Clarity, Spec §FR-003]

## Requirement Clarity — the permission model

- [ ] CHK009 Is FR-002's "specific area within a module" defined with a criterion for what constitutes an area, or is it left to be inferred per module? [Ambiguity, Spec §FR-002]
- [ ] CHK010 Is FR-007's "define these finer roles without a code change" distinguishing **composing a role from existing areas** (true today) from **inventing a new area** (a migration)? [Ambiguity, Spec §FR-007 — the two readings are different features]
- [ ] CHK011 Is FR-004's "hide, not merely disable" measurable from the backend's contract, given that hiding is an interface behaviour? [Measurability, Spec §FR-004]
- [ ] CHK012 Can FR-006's "no silent widening or narrowing" be objectively verified, and does any requirement say by what means? [Measurability, Spec §FR-006 — SC-002 names an access matrix; FR-006 does not]

## Requirement Consistency

- [ ] CHK013 Does the spec's claim that Note 22 "cannot be expressed at all" agree with FR-002, given that `LOGBOOK` and `FUEL` are already distinct permissions? [Conflict, Spec §What exists and what is inexpressible vs research §2]
- [ ] CHK014 Is the Key Entities description of Role as "company-scoped" consistent with any requirement, and with the schema where `Role.name` is globally unique? [Conflict, Spec §Key Entities vs research §7]
- [ ] CHK015 Do FR-010 ("scope every list, report and creation to the selected company") and the Assumption that RLS already enforces isolation agree on which one is authoritative? [Consistency — if both are, one is redundant; if only one is, the spec should say which]
- [ ] CHK016 Are the terms "area", "module" and "sub-module" used consistently across FR-001, FR-002 and FR-005? [Terminology]

## Requirement Completeness — company scoping

- [ ] CHK017 Are requirements defined for a **stored selection that becomes invalid** because the user's access was revoked? [Spec §Edge Cases raises it; no FR covers it]
- [ ] CHK018 Does any requirement state whether the selection is authorisation or only a context choice? [Gap — the distinction decides whether a forged selection is a cross-tenant read]
- [ ] CHK019 Are requirements defined for a record opened by **direct link** belonging to a company other than the selected one? [Spec §Edge Cases raises it; no FR answers it]
- [ ] CHK020 Is FR-012's "clear data belonging to the previous company from view" specified in a way a backend contract can satisfy, or is it entirely an interface obligation? [Clarity, Spec §FR-012]
- [ ] CHK021 Are requirements defined for **reports that aggregate across companies** for a cross-company user? [Spec §Edge Cases raises it; FR-010 appears to forbid it]
- [ ] CHK022 Is there a requirement covering what company a record is created in when the caller has **no** stored selection yet? [Gap, Spec §FR-010]
- [ ] CHK023 Are requirements defined for the case where two companies hold a user with the same email? [Spec §Edge Cases raises it; no FR]

## Requirement Completeness — cash visibility

- [ ] CHK024 Is the set of surfaces that count as "cash" enumerated, or left as "across the application"? [Gap, Spec §FR-014 — the spec's own second open question]
- [ ] CHK025 Are requirements defined for whether a hidden amount is **absent, null, or zero** in a response or export? [Gap — a zero and a hidden value are indistinguishable to a spreadsheet]
- [ ] CHK026 Does any requirement address a screen that becomes **unusable** with its amounts hidden, such as a labour payment sheet? [Spec §Edge Cases raises it; FR-015 requires consistency regardless]
- [ ] CHK027 Is FR-015's "consistently to screens, reports and exports" measurable, given that the backend cannot observe a screen? [Measurability, Spec §FR-015]
- [ ] CHK028 Are requirements defined for whether cash may still be **entered** while hiding is on? [Spec's first open question — FR-014 assumes display only, and the assumption is load-bearing]
- [ ] CHK029 Is "who may change the cash setting" (FR-016) specified as a named permission, or left as "restrict who can"? [Clarity, Spec §FR-016]
- [ ] CHK030 Does FR-016's recording requirement specify where the record lives and how long it is kept? [Completeness, Spec §FR-016]
- [ ] CHK031 Is the scope of the setting stated — per company, per user, or system-wide? [Gap — "a setting that hides cash across the application" names no owner, and the Key Entity calls it company-level without a requirement saying so]

## Acceptance Criteria Quality

- [ ] CHK032 Can SC-002's "access matrix compared across the change" be produced from what the requirements describe, or does it assume a tool no requirement asks for? [Measurability, Spec §SC-002]
- [ ] CHK033 Is SC-005's "verified across every module that holds one" bounded by an enumerated list of such modules? [Measurability, Spec §SC-005]
- [ ] CHK034 Is SC-006's "verified by direct interface calls rather than through the interface alone" specific enough to know when it has been satisfied? [Clarity, Spec §SC-006]
- [ ] CHK035 Does NFR-002's 50ms target state what it is measured against, given the spec admits no baseline exists? [Measurability, Spec §NFR-002]

## Scenario and Edge Case Coverage

- [ ] CHK036 Are **recovery** requirements defined for a migration that widens or narrows access — how it is detected and what is done? [Gap, Coverage — Recovery class absent]
- [ ] CHK037 Are requirements defined for a role edited to remove write access **while a holder has an unsaved form open**? [Spec §Edge Cases raises it; no FR]
- [ ] CHK038 Are requirements defined for the interaction between this feature's refusals and feature 016's approval chains — can a read-only role approve? [Gap, Coverage — cross-feature]
- [ ] CHK039 Are requirements defined for what a **Super Admin** sees, given that role holds every permission and cannot be narrowed? [Gap — the one role for which read/write granularity is inexpressible by design]
- [ ] CHK040 Is the behaviour of an **export** under cash hiding specified as a distinct scenario from a screen, or assumed to follow? [Coverage, Spec §FR-015]

## Dependencies and Assumptions

- [ ] CHK041 Is the assumption that "RLS already enforces company isolation" validated anywhere, or taken on trust? [Assumption, Spec §Assumptions — the plan's migration hazard says this assumption has failed in production before]
- [ ] CHK042 Is the assumption that `CROSS_COMPANY_ACCESS` keeps its current meaning stated as a constraint on this feature, or as a hope? [Assumption]
- [ ] CHK043 Are the three open client questions marked in a way that makes clear which requirements are **load-bearing** on each answer? [Traceability — FR-014 rests on the cash-entry answer; FR-006 rests on the role-mapping answer]

## Notes

The three open `[NEEDS CLARIFICATION]` markers in the spec are **not** defects in requirements
quality and must not be closed by guessing. Each names a decision only the client can make, and the
plan phases the work that depends on them last for that reason.

CHK013 and CHK014 are the two items where the specification says something the code contradicts.
Neither is a small wording problem: CHK013 changes how large US1 is, and CHK014 describes an entity
shape that does not exist. Both are recorded in research §2 and §7 and in plan D8.
