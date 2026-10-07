# Quickstart: Projects defect register (028)

Seven passes, one per phase. Each is the thing a person would do, and each names the observation
that proves it — not the code path.

**Prerequisites**: `npm ci` in both repositories; API on `localhost:3000`; web on `localhost:3001`;
seeded dev login. **e2e runs against `buildcore_scratch` only** — never the dev database.

```
npx jest                                     # unit, both halves
npx jest src/approvals/fr-022-unmigrated-modules.spec.ts    # before every src/ commit
DATABASE_URL=...buildcore_scratch npx jest --config ./test/jest-e2e.json
npm run build                                # both repositories
```

---

## Pass 1 — a second subcontractor can be billed (Phase A)

1. On a project with two work orders, compose a package for the first. It numbers RA-01.
2. Compose a package for the **second** work order.

**Expect**: a bill numbered **RA-01**, on its own contract. Before this feature the second
composition answered `[P2002]: Invalid 'prisma.rABill.create()' invocation`.

3. Compose a second bill for the first work order.

**Expect**: RA-02.

**The trap**: a pass here that only checks the first composition succeeded proves nothing — it
succeeded before.

---

## Pass 2 — a deduction reaches the document (Phase B)

1. Record a recovery on a package through the adjustments screen.
2. Download the bill as a PDF.

**Expect**: the figure in the abstract of the **rendered document**. Not in the database, not in the
API response — the PDF, which is what the subcontractor receives.

3. Attempt to send `advanceRecovery` to `PATCH /projects/ra-bills/:id`.

**Expect**: 400. The second store is closed, not merely unused.

---

## Pass 3 — an award is approved before it commits anything (Phase C)

1. Raise a work order. **Expect**: pending approval, not active.
2. Compose a bill against it. **Expect**: refused, naming the work order.
3. Approve it. Compose again. **Expect**: it proceeds.

**The trap**: step 2 alone passes for a guard that refuses everything. Step 3 is the half that makes
it mean something.

---

## Pass 4 — the rate is agreed, then fixed (Phase D)

1. Record a purchase of an item never bought from this vendor. Type a rate. **Expect**: accepted, and
   the rate is now agreed.
2. Record another purchase of the same pair. **Expect**: the rate supplied, the field read-only.
3. **Send a different rate directly to `PATCH /inventory/purchases/:id`.**

**Expect**: 409 `PURCHASE_RATE_FIXED`, naming the agreed rate and its effective date.

**The trap**: checking the form field is disabled proves nothing about the endpoint behind it.

4. Record a first purchase of the same item from a _different_ vendor.

**Expect**: typed freely — a new pair is a first purchase — **with the other vendor's agreed rate
shown beside it**. This is the chosen limit of the control, not a hole in it.

---

## Pass 5 — paper and money (Phase E)

1. Raise a debit. **Expect**: a note number, allocated now and not at print.
2. Download its PDF. **Expect**: the same number on the document as in the register.
3. Upload a signed copy against a certified bill. **Expect**: the bill reports **acknowledged**.
4. Record a part payment of ₹60 against a bill certified at ₹100.

**Expect**: ₹40 outstanding, reported without anybody subtracting.

---

## Pass 6 — a day's work leaves the building (Phase F)

1. Submit a daily report and download the workbook.

**Expect**: cells matching the client's own form. Read the cells back; bytes returning is not the
assertion.

2. Record a day. **Expect**: no weather control.
3. Read a report submitted by someone other than its author.

**Expect**: both names, separately.

---

## Pass 7 — the screens stop hiding what they hold (Phase G)

1. Open the bill composer on a project with several subcontractors.

**Expect**: a subcontractor chosen first, then only their work orders.

2. Choose a work order, then **change the subcontractor**.

**Expect**: the work order selection cleared. A stale one composes a bill against the wrong contract.

3. Find a work order with no subcontractor recorded.

**Expect**: reachable in the picker. Filtered out, it is unbillable with nothing on screen to say why.

4. With a project open, change the selected company.

**Expect**: the portfolio of the company now selected, **with an explanation on arrival**. Not an
error, and not a silent redirect that reads as the app losing your place.

5. Open the project overview.

**Expect**: the client's retention and the quoted percentage, under Commercial terms.

---

## What must NOT change

- Editing a project must still save. The withdrawn "document is mandatory" report receives **no code
  change**; if a pass here produces that refusal, something was altered that should not have been.
- Every work order already `active` stays active. A migration that set live awards to pending
  approval would make every project in flight unbillable.
- The refusal after a company switch stays a 404 at the API.
