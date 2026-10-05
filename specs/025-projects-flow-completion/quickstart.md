# Quickstart: Projects Flow Completion

Six passes. Pass 1 is the defect the user reported; passes 2 and 3 are the two halves of the journey
that could not be walked at all. Each pass states what proves it, because "the screen loaded" is not
evidence.

**Prerequisites**: the API on `localhost:3000`, the web on `localhost:3001`, the seeded development
login, and a project with an imported BOQ.

---

## Pass 1 - A day can be recorded (FR-001 to FR-007a)

1. Open a project, **Daily work**, **Record a day**.
2. Date, people on site, machines on site.
3. **Add a measured line.** Pick a BOQ item. Fill **Nos = 2**, **Length = 5**, **Breadth = 2**,
   **Depth = 1** - *fill the Nos box, because filling it is what used to fail.*
4. Confirm the preview reads **20.000** before saving.
5. Save.

**Proves**: the report saves and appears in the list under its `dprNumber`.
**Would have failed before**: step 5 returned 400 from the unknown `nos` field, or - with that field
left empty - returned 201 and rendered a zod error naming `reportNumber`, `projectId`, `workDate`.

**Then record a day dated before the project started.** It must save, with the warning shown beside
the success in a sentence, not as a failure. A warning rendered as an error is how a day gets
recorded twice.

---

## Pass 2 - An imported line can be planned (FR-009 to FR-015)

1. Open **BOQ**. Find a line reading *Not planned* in all three programme columns.
2. Edit it in place: start date today, finish date in 60 days, no per-day target.
3. Read the row back.

**Proves**: *Finish by* shows the date and *Per day* shows the **derived** needed rate - outstanding
quantity over days remaining - not a blank. The line now appears under one of the alert tabs.

4. Record and approve a day's work against the line, then re-read.

**Proves**: *Avg / day* reports an achieved rate. This column could not populate at all before,
because nothing in the product set a start date.

5. Clear the finish date explicitly.

**Proves**: the row returns to *Not planned* - and a request that simply omits the field leaves it
alone. **Both halves must be checked**; a clear that works and an omission that also clears is a
planner's work silently discarded.

6. Try a finish date before the start date.

**Proves**: refused, naming the contradiction. Try it as a PATCH carrying **only** the finish date,
against a stored start date - the check must read the merged programme, not the request.

---

## Pass 3 - A bill can be raised to the client (FR-016 to FR-020)

1. On a project with no retention term, **RA bills**, direction *To the client*, a period, Compose.

**Proves**: refused, naming the missing retention term and what to do. This refusal is correct and
must survive the feature.

2. Open **Edit** on the project. Enter **Client retention 5%**. Save.
3. Re-open the project's edit form.

**Proves**: it reads **5%**, not 0.05 and not 4.999999. A round trip that drifts is a bill that
disagrees with the contract.

4. Compose again.

**Proves**: the package opens, and its abstract withholds retention at 5% of the work done. **This
is the first time the client direction has been exercised end to end.**

5. Issue it and download the workbook.

---

## Pass 4 - A statutory rate can be changed (FR-021 to FR-024)

1. Read the four rates in settings: 9%, 9%, 18%, 2%.
2. Compose a package, issue it, note the tax figures.
3. Change TDS to 2.5%.
4. Re-read the **issued** package.

**Proves**: unchanged. Issue freezes rates, and a feature that makes them editable must not
accidentally unfreeze them. This is the pass most likely to be skipped and the one that matters
most - it is the only check that an editable rate cannot rewrite a document already sent.

5. Compose a **new** package.

**Proves**: 2.5%.

6. Check the activity log.

**Proves**: the change is recorded with who, when, and from what to what.

---

## Pass 5 - What was built becomes reachable (FR-025 to FR-034)

Walk each surface once. For each, the only question is whether it reaches the endpoint - **no screen
in this pass may enforce a rule of its own.**

1. Attach a photograph to a daily report; open it again from a fresh page load.
2. Correct a draft report's figure without deleting the day; then delete a different draft.
3. Open the reconciliation. If a difference exists, repair it deliberately and watch it recorded.
4. Open a bill package, open one line's measurement sheet **on screen** - the claim history across
   bills and the daily record beneath it.
5. Raise a debit, apply it to a draft package, then try to apply it to a second. The second is
   refused, by the server, with the server's own sentence shown.
6. Revise an issued package; abandon a draft one.
7. Open the understatement report and the over-claim report. Each states its denominator.
8. Edit a work order. Release retention against it.
9. Import an estimate.
10. Open **Letters** under the project and produce a work order letter.

**Proves**: twelve client functions that had no caller now have one, and six endpoints that had no
client now have one.

---

## Pass 6 - The corrections (FR-035 to FR-038)

1. Set a site inactive. Punch attendance there.

**Proves**: refused, naming the site's state.

2. Read the project's costing breakdown against the figures the project reports elsewhere.

**Proves**: they reconcile, or the screen states which basis it uses.

3. Run the suite.

**Proves**: an authenticated caller holding other permissions but **not** `PROJECT_FINANCIALS` is
refused by the bill-package routes. A caller with no permissions at all would also be refused by a
route guarded by nothing, which is why the test's caller holds others.

---

## What none of these passes prove

**That a client and the server still agree tomorrow.** The exact-wire-shape assertions pin what the
server promises; nothing automated reads the client against it, because buildcore-web has no test
runner and this feature declined to add one for a single check. See research.md section 3 for the
upgrade path and the condition that should trigger it.
