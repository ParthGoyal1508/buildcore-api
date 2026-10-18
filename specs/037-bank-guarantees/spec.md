# 037 — Bank Guarantees

Requested 18-10-2026, with the client's sheet "TIRUPATI ENTERPRISES TENDER BG DETAILS" as the format.

## Requirement (client)

- Create Bank Guarantees with the fields in the client's sheet.
- Attach documents to each Bank Guarantee (for example the scanned BG copy).
- Notify automatically 30 days before a Bank Guarantee expires.

## Decisions (user, 18-10-2026)

1. **A tender with its BGs.** A tender is entered once: work name, department name, tender amount, and an optional link to a project. Any number of BGs sit under it. Each BG is EMD or PBG and has its own number, amount, dates, status and documents.
2. **Statuses: Running, Released, Encashed, Expired.**
   - Released records the date the department returned it.
   - Encashed records the date and the amount invoked.
   - Expired is not stored. It is shown when the expiry date has passed and the BG is still Running.
   - Extending a BG changes its expiry date, and the previous date is kept in its history.
3. **It lives under Projects and has its own permission.** The new permission is `BANK_GUARANTEES` (read and write), granted through Settings, Roles.
   - Everyone holding it gets an in-app (bell) alert 30 days before expiry, and again if it passes expiry without being released or extended.
   - There are no emails (036 decision D6).
4. **Extra fields, all optional:** issuing bank and branch, claim period end date, margin money / FD, and remarks. When a claim period end date is set, the BG stays live for alerts until that date. "Expired" then means the claim period has also passed.

## Fields

**Tender**

| Field | Required | Notes |
|---|---|---|
| Sr. No | auto | Running number per company, shown in the register and the export |
| Work name | yes | Multi-line text |
| Department name | yes | e.g. NHAI DELHI, RAMGANJMANDI |
| Tender amount | no | ₹. Blank for some rows in the sheet |
| Project | no | Link to a project in the portfolio |
| Remarks | no | |

**Bank Guarantee**

| Field | Required | Notes |
|---|---|---|
| Type | yes | EMD or PBG |
| BG number | no | Can be blank while applied for (row 39 of the sheet). Unique per company when present |
| Amount | yes | ₹ |
| Issue date | no | Required once the BG number is entered |
| Expiry date | no | Required once the BG number is entered |
| Claim period end date | no | On or after the expiry date |
| Issuing bank, branch | no | |
| Margin money amount, FD reference | no | |
| Status | yes | Running (default), Released (+ date), Encashed (+ date, amount) |
| Remarks | no | |
| Documents | no | Any number. PDF or image; images compressed. Each has a name and who uploaded it, and when |

## Screens (web, Projects → Bank Guarantees)

- **Register.** One row per tender, the same columns as the client's sheet: EMD and PBG side by side. When a tender has several BGs of one type, they stack in that cell.
  - Search by work name, department or BG number.
  - Filters by status ("Expiring in 30 days", Running, Released, Encashed, Expired) and by project.
  - An "Excel" button downloads the sheet in the client's format.
- **Tender page.** Shows the tender's details and its BGs, each with its status, history and documents.
  - Add BG, Edit, Extend (new expiry date with a reason), Mark released, Mark encashed.
  - Upload and download documents.
- Write actions only for `BANK_GUARANTEES` write; the register is read-only otherwise.

## Alerts

- A reminder rule, `projects-bank-guarantee-expiry`, with a 30-day lead. The whole 30 days is its warning band, because the bell carries only warning and overdue reminders. A bell entry appears once at 30 days and turns unread again if the BG goes overdue.
- It covers Running BGs whose expiry date (or claim period end, if set) falls within 30 days, including ones already past it but not yet released.
- The alert links to the tender page. Released and encashed BGs drop out.

## Export format

The title row reads "<COMPANY NAME IN CAPITALS> TENDER BG DETAILS". The columns are:

- Sr. No, Work Name, Department Name, Tender Amount
- EMD: BG Amount, BG Number, Issue Date, Expiry Date, Status
- PBG: Amount, BG Number, Issue Date, Expiry Date, Status

Dates are DD.MM.YYYY, as in the sheet. A tender with more than one BG of a type gets one row per pair; only the first row repeats the tender columns.
