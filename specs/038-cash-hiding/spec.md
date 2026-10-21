# 038 — Hiding cash means cash does not exist (hide **and** block)

**Status**: in progress · **Date**: 2026-10-20 · **Supersedes**: 019 FR-017a, and the web 019 Q&A
"With cash hiding on, may cash still be entered? → Yes".

## Why
019 split the client's original answer ("hide and block") into two controls: `hideCashTransactions`
masked a few amount fields, and the `CASH_ENTRY` permission decided who could enter cash. In use, the
client found cash rows, totals and exports still showing, and anyone with the permission could keep
recording cash while it was "hidden". The client's rule (2026-10-20):

> When cash is hidden for a company, no cash transaction shows anywhere in the app, and nobody can
> create a new cash entry until the option is turned back on.

## Decisions (client, 2026-10-20)
- **D1 — Everyone, Super Admin included.** Nobody sees or enters cash while it is hidden. Turning the
  setting off (Super Admin, password-confirmed, audited — unchanged from 019 FR-016) is the only way back.
- **D2 — Totals leave cash out.** Every total, report, export, dashboard figure and the P&L is computed
  without cash rows, as if they had never been recorded. Figures drop while hidden; nothing on screen
  reveals that cash existed.
- **D3 — Labour paid in cash counts.** Cash-disbursed payment-sheet lines, direct-engagement (cash)
  payment sheets and labour advances (paid in cash at site) are hidden and cannot be created.

## What counts as cash
| Record | Cash when |
|---|---|
| `inventory.Payment` (vendor payment) | `paymentMode = cash` |
| RA bill payment | `instrument = cash` |
| `labour.PaymentSheetLine` | `paymentMode = cash` |
| `labour.LabourPaymentSheet` | engagement is direct (paid in cash with a denomination breakup) |
| `labour.LabourAdvance` | always |
| `plant.EquipmentDisposal` | sale received in cash (`paymentMode = cash`) |

## Requirements
- **FR-001 Reads.** With cash hidden for a company, no cash record of that company appears in any list,
  detail, search result, report, export (xlsx/pdf/docx), document, dashboard tile, notification, reminder
  or activity-log entry. A by-id read of a cash record answers 404.
- **FR-002 Totals.** Every aggregate (paid, outstanding, allocated, unallocated, gross/net totals, cost
  sources feeding the P&L, report totals) is computed from non-cash records only.
- **FR-003 Writes.** With cash hidden, creating, editing, deleting, approving, disbursing or reversing a
  cash record — or creating a record in a cash mode — is refused with 403 `CASH_HIDDEN`, for every caller.
  Enforced in two places: the global `CashEntryInterceptor` (request bodies carrying a cash mode) and an
  explicit `CashPolicyService.assertCashAllowed(companyId)` in each service write path that is cash by
  nature (labour advances, direct cash sheets, edits/deletes of existing cash rows).
- **FR-004 Forms.** The web drops "Cash" from every payment-mode picker and hides cash-only actions
  (labour advances, direct cash sheets, denomination breakups) while hidden; `GET /my/cash-policy`
  tells it, for any signed-in user.
- **FR-005 Unchanged.** Turning it off restores everything exactly — hiding never deletes or alters data.
  `CASH_ENTRY` still decides who may enter cash while it is *not* hidden.
- **FR-006 Cross-company views** (group dashboard) apply each company's own setting to that company's rows.

## Shared code
`src/common/cash/cash-policy.ts` — `CashPolicyService` (`isHidden`, `hiddenAmong`, `assertCashAllowed`),
`isCashHidden(prisma, companyId)`, `isCashHiddenTx(tx, companyId)`, `cashHiddenCompanyIds`, `servedCompanyOf`,
`cashHiddenError()` / `CASH_HIDDEN_CODE`. The 019 masking interceptor stays as a backstop.
