# 036: manual verification checklist

This is for checking 036 by hand before it is merged into `004-dashboard` / `004-dashboard-backend`.

**Already checked automatically in Wave 5:**
- Every page loaded in a real browser at desktop (1440), tablet (820) and phone (390) width: 142 routes, 426 page visits. No uncaught errors, no unexplained failed requests and no sideways scrolling remain.
- Full unit suite, and every e2e suite on a freshly provisioned database.

What is left is what a machine can't judge: does the flow make sense, and does it look right. Each item takes a minute or two.

**Setup:**
- Run `npx prisma migrate deploy` on your database.
- Restart the API. If `nest start` reports duplicate-property errors in `src/metadata.ts`, delete that file once; it is generated and git-ignored.
- Sign in as a Super Admin. Where an item says "second user", use a different account with the relevant module role.

## Everywhere
- [ ] **Dates and times:** dates show as DD-MM-YYYY, times as 24-hour HH:mm. Headings like "Friday, 17 October 2026" stay in words.
- [ ] **Errors:** turn the API off and open any list. You get a red box with **Retry**, never a blank page or a spinner that never stops. Turn the API on and click Retry: the list loads.
- [ ] **Saving:** a save shows a green message, and a failure shows a red one with the reason. The form keeps what you typed.
- [ ] **Unsaved changes:** press **Esc** in a form with unsaved changes. It asks "Discard changes?". Esc on an open dropdown or calendar closes only that.
- [ ] **Filters:** filter a list, open a row, press Back. The filters and page are still there, and the URL can be shared.
- [ ] **Long lists:** pickers for employees, items, vendors, machines and projects let you type to search, and show "Showing N of M".
- [ ] **Tablet width:** the sidebar becomes an icon rail with an expand button. Tab bars that overflow show arrows.
- [ ] **Two tabs:** in tab A switch company, then save something in tab B. Tab B shows "Company was changed to … in another tab" with Reload.

## Settings and approvals
- [ ] **Users:** edit a user and give them two roles. Both stay after Save. Your own row has no Delete and no status change.
- [ ] **Roles:** a new custom role belongs to your company. The same name can exist in another company.
- [ ] **Approval History:** pick a month, a date range and a search. The CSV export has the same rows.
- [ ] **Notification bell:** shows unread items. Mark one as read, then **Mark all read**.
- [ ] **Read-only approvers:** an approver with read-only access to a module still sees Approve/Reject on that module's items.

## HR and payroll
- [ ] **Employees:** Status → Inactive shows only inactive employees.
- [ ] **Payroll run detail:**
  - The columns add up to Gross and Net.
  - Exceptions (for example, no PAN) are listed by name.
  - Discard draft works on a draft.
- [ ] **Bank sheet:** generate it (POST), then download it again from the history. The history follows the selected month.
- [ ] **Advance or loan:** whoever recorded it, or receives it, gets no Approve button.
- [ ] **Employee document:** **Replace** asks for the new number and expiry. **View** opens it in the page. History lists the earlier version.
- [ ] **Reimbursements:** **View receipt** works. Approve asks for confirmation and names the employee and amount.

## My Workspace (phone width)
- [ ] **Apply leave:** the day count comes from the server and lists the excluded dates.
- [ ] **Payslip:** earnings minus deductions equals net, and fuel and advance recovery rows appear when they apply.
- [ ] **Claim:** a PDF receipt is accepted, and a photo is compressed and previewed before upload.

## Projects and billing
- [ ] **Locked project:**
  - Write buttons disappear (except payments).
  - Unlocking needs the new Project Lock permission.
- [ ] **Daily work report:**
  - Type half a report and refresh. It offers to restore your draft.
  - Photos show thumbnails, and a large photo uploads.
- [ ] **RA bill:** you can type 10.05 into a quantity. Two drafts that together exceed the award: the second is refused at submit.
- [ ] **Issue a bill package:** the confirmation shows net payable, bill number, missing header fields and any GST basis warning.
- [ ] **Client:** clear a client's GSTIN and save; it stays cleared. Create a client with no email; it works.
- [ ] **Group P&L:** select four or more projects; it loads.
- [ ] **File viewer:** the **Print** button prints the open PDF.

## Plant and assets
- [ ] **Equipment photos:** add a photo; it becomes main and shows as a thumbnail. Photos stay optional.
- [ ] **Logbook:**
  - Adding or editing a day inside a verified hire-bill period is refused.
  - **Correct readings** asks for a reason.
  - An opening reading that doesn't match the previous closing asks for a reason.
- [ ] **Logbook sheet:** type some days, then change machine. It asks before discarding.
- [ ] **Hire bills:** the form shows the logbook hours for the period. The creator can't verify the bill. Pay asks for a payment date.
- [ ] **Phone width:** the equipment register doesn't scroll sideways.

## Inventory, partners and labour
- [ ] **Purchase orders:**
  - The printed PO looks exactly as before.
  - The **Trace** page shows ordered, received, billed and paid.
  - A delivery above the ordered quantity is refused.
- [ ] **Delete a purchase:** refused with the available stock shown once that stock has been issued.
- [ ] **Transfers:** receiving less than sent asks for a reason.
- [ ] **Record payment:**
  - A cash payment needs no reference.
  - A double-click records one payment.
  - A duplicate reference shows a warning.
- [ ] **Stock ledger:** opens from a stock row, with a date range and an export.
- [ ] **Vendor form:** an error on a hidden tab switches to that tab.
- [ ] **Contractor documents:** **View** opens the file.
- [ ] **Labour payment sheet:**
  - The period must end before today.
  - Draft sheets can be deleted and regenerated.
  - Short payments appear as "Balance carried forward" on the next sheet.
- [ ] **Night shift:** punch in at night and punch out the next morning. A correction offers "punch out next day".
- [ ] **Names:** labour reports, musters and advances show names, not ids.

## Release and data (before production)
- [ ] **Configuration:** set `CORS_ORIGINS` (or `none`).
- [ ] **Dependencies:** run `npm install` (adds helmet).
- [ ] **Migrations:** run `prisma migrate deploy` (20 migrations from 036).
- [ ] **Data-repair reports:** run them read-only against production data and decide on repairs:
  - `npx ts-node scripts/036-report-payroll-recoveries.ts`
  - `npx ts-node scripts/036-report-labour-advances.ts`
- [ ] **Release note for users:** DD-MM-YYYY dates; stricter upload types and sizes; nobody approves their own requests; labour sheets end before today; reasons are required for logbook gaps and transfer shortages; payroll drafts must be regenerated if inputs changed; the company-changed warning across tabs; custom roles belong to one company.
