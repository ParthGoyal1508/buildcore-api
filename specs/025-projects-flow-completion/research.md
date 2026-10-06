# Research: Projects Flow Completion

Six decisions. Each records what was rejected, because in a completion feature the tempting move is
almost always to build something new beside what exists rather than to connect it.

---

## 1. Who knows the author of a report

**Decision**: `DwrService.list` grows `createdByUserId` and `submittedByUserId` in its `select`, and
the published contract moves with it in the same commit.

**Rationale**: 022 FR-012a says the author of a report may not approve it, and the server enforces
it. The panel disables the Approve button with the reason on it rather than offering an action that
will be refused - which is the better interface, because a control that explains itself before being
pressed is the difference between a rule and an error message. That control reads two fields the
list does not send, so today it never fires: every submitted report shows an enabled Approve button,
and the author discovers the rule by being refused.

Both columns already exist on `DailyWorkReport` and are already read by the detail endpoint. This is
two lines in a `select`, and it is additive: no existing consumer breaks.

**Alternatives considered**:

- *Drop the control and let the server refuse.* Smaller diff - about ten lines deleted instead of
  two added - and genuinely tempting under a laziness rule. Rejected because it deletes a working
  interface decision to avoid a two-line server change, and because the refusal arrives after the
  approver has already read and judged the report.
- *Fetch each report's detail to find its author.* One request per row to learn a fact the list
  could carry. Rejected on sight.

**The trap this decision walks into, named so the implementation avoids it**: changing a response
shape is exactly what caused this feature. The contract document is updated in the same commit, not
afterwards.

---

## 2. What the Lines column shows

**Decision**: a count, from the `lineCount` the list already carries.

**Rationale**: the list is a page of summaries. Rendering the first three lines with their
quantities, as the panel does today, requires an array the server has never sent - so the column
currently renders "none" for every report regardless of content. A count is honest, is already
computed, and is what a list is for; the lines themselves are one click away on the detail screen,
which does send them.

**Alternatives considered**: *grow the list to carry lines.* Rejected - a list page of fifty reports
would carry several hundred lines to render three of each, and the detail endpoint already exists.

---

## 3. The divergence check, and what it cannot do (FR-008)

**Decision**: assert the **exact wire shape** in buildcore-api's end-to-end suite - the sorted key
list of the creation response and of a list item - and put a pointer in the web module naming the
contract file it was aligned against. **No automated check will span the two repositories.**

**Rationale**: the honest version of FR-008 has to start from a fact found during planning:
**buildcore-web has no test runner.** Its `package.json` has four scripts - `build`, `dev`, `start`,
`lint` - and no jest, no vitest, no testing-library. Satisfying FR-008 symmetrically would mean
introducing a test framework, its configuration, its CI step and its first fixture, in order to run
one assertion. That is a permanent surface for a single check, and the laziness rule and the
engineering judgement agree for once: no.

What *is* cheap is pinning the server's promise. An exact-key assertion on the wire fails the moment
a field is added, removed or renamed - which is the event that would silently break any client. It
does not prove any client reads it correctly; it proves the thing a client is entitled to rely on.

**What this does not catch, stated plainly rather than left implied**:

- A client that reads a field correctly but *renders* it wrongly.
- A client written against a stale copy of the contract after the contract has moved.
- The contract document drifting from the code - which is why the check is anchored to the response
  on the wire, not to the markdown.

**Alternatives considered**:

- *Grep the contract document for forbidden names.* Checks prose against prose. A document that says
  `dprNumber` while the code returns something else passes happily.
- *Generate the web's types from the API.* The correct long-term answer, and far beyond this
  feature: it needs a schema source of truth (OpenAPI is emitted by the Nest Swagger module but is
  not currently published or consumed), a generation step and a check that the generated output is
  current. Recorded here as the upgrade path.

**When to revisit**: the first time buildcore-web needs a test runner for any other reason. Then the
fixture-parse test costs nothing and should be added.

---

## 4. How a programme field is cleared (FR-011)

**Decision**: `null` clears, omission leaves unchanged. Expressed with the validators already in the
repository and no custom decorator.

**Rationale**: `@IsOptional()` in class-validator skips every other validator on the property when
the value is `null` **or** `undefined`. That is usually described as a wart; here it is exactly the
behaviour wanted, because the global pipe's `whitelist` keeps a declared property that arrives as
`null` while an absent property stays `undefined`. The service then distinguishes them with a plain
`!== undefined`, and Prisma accepts `null` as a write of SQL NULL.

So the distinction the requirement needs falls out of validators that are already in use, with no
custom decorator, no `@Transform`, and no sentinel value.

**Alternatives considered**:

- *A separate `clear: ['finishDate']` array.* A second way to express the same intention; two ways to
  clear a field is two code paths and one of them will be wrong.
- *Treat an empty string as a clear.* Ambiguous against a legitimately empty text field elsewhere,
  and invites a date parser to decide what `""` means.

---

## 5. Which side converts the retention percentage (FR-017)

**Decision**: the column stores a **fraction**; the API accepts a fraction bounded `[0, 1]`; the web
form collects a percentage and divides by 100 before sending.

**Rationale**: this is not a free choice - the convention already exists. `WorkOrder.retentionPercent`
is documented in the schema as "Retention withheld per RA bill, as a fraction", its DTO bounds it at
`@Min(0) @Max(1)` with the comment that a retention of more than the bill makes every net payable
zero, and `bill-sheet.tsx` already divides by 100 at the form. The same bill composer reads both
terms: `resolveRates()` takes `project.clientRetentionFraction` for a client bill and
`workOrder.retentionPercent` for a subcontractor bill, in the same function, four lines apart.

Two conventions in one function is how a 5% term becomes a 500% deduction. The new field follows the
old one exactly - same type, same bound, same precision, same place of conversion.

**Alternatives considered**:

- *Accept a percentage in the API and convert server-side.* Defensible in isolation, and arguably
  nicer. Rejected because it would make the two retention terms read by one function differ in
  units, which is the specific failure the rule exists to prevent.
- *Rename the column.* Out of scope: a migration for a naming improvement, in a feature whose
  headline property is that it ships none.

---

## 6. Where the programme's internal consistency is checked (FR-012)

**Decision**: against the **merged** result - stored values overlaid with the request - not against
the request alone.

**Rationale**: a PATCH is a partial update, so a request carrying only `finishDate` must still be
refused when that date falls before the start date already stored. Validating the DTO in isolation
would accept it, and the line would end up with a negative duration that every derived figure -
needed rate, days remaining, the five-state classification - would then compute from.

This also means the check cannot live in a DTO validator, which sees only the request. It lives in
the service, after the row is read and before it is written, inside the same transaction.

**Alternatives considered**: *validate the request only, and let the derived figures cope.*
Rejected: `neededRate()` divides by days remaining, and a negative denominator produces a per-day
target that reads as a plausible small number.

---

## Confirmed during research, not assumed

- **No new table, and therefore no isolation probe owed.** Checked column by column against
  `prisma/schema.prisma`: the four programme fields, `clientRetentionFraction`, the four tax
  fractions, the two author columns and `AuditEntityType.COMPANY` all exist today.
- **Twelve client functions already written and unused.** `abandonBillPackage`, `applyDebit`,
  `deleteDwr`, `getClientBill`, `getMeasurementSheet`, `getOverClaimReport`, `getPeriodFigures`,
  `getRaBill`, `getUnderstatementReport`, `recordDebit`, `reviseBillPackage`, `updateWorkOrder`.
  Phase E connects these; it does not write them.
- **Six endpoints have no client function at all**: the two DWR attachment routes, `PATCH` a draft,
  the reconciliation read and its repair, and the two retention-release routes. These need a wrapper
  each, in the existing module style.
