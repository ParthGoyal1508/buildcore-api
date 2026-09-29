Here's the rephrased and organized version:

---

## Feature Requirements & Enhancements

### 1. Company Document Management
Upload and download company-level documents (GST, PF, Aadhaar, PAN Card, ESIC, Labour License, TAN, PAN, Cancelled Cheque) directly from the portal.

### 2. Attendance Management
- Block attendance marking if location or photo verification fails.
- Log all manual attendance modifications (by any role) with details of who changed what, and it should also reflect in the attandence of the affected employee.

### 3. Project Document Management
- Attach required documents (LOI, Work Order, Insurance, Mining Permission, Labour Insurance, BOQ, etc.) when creating a project. It should be configurable from the settings.
- Super Admin can configure mandatory documents; Project Managers cannot create a project without them.
- All uploaded documents should be visible directly on the project page.

### 4. Project Search
Add a search bar on the dashboard to quickly find projects.

### 5. Multi-Company Support
Enable company selection at the root/top level of the portal (Tirupati Enterprises and Parth Realcon Pvt. Ltd.) rather than at the module or sub-module level.

### 6. Payroll Automation
- Auto-run payroll on the 1st of every month.
- Approval chain: Site Incharge → HR Office → Director (final payment approval).
- Only HR can modify attendance or payroll data after the run.

### 7. Director Approval for All Final Actions
Every critical action across the system requires Director-level approval before execution.

### 8. Salary Slip Email Notification
Automatically email salary slips to employees when payment is transferred and the transaction sheet is uploaded to the portal.

### 9. Advance Salary Settlement
When payroll is processed, outstanding salary advances should be automatically adjusted and reflected in the bank payment sheet download.

### 10. Full & Final Settlement (F&F)
- Mandatory F&F process for every exiting employee covering final balance settlement, return of company documents, and ID deactivation.
- Support for asset allocation tracking — any assets assigned to the employee should appear in the F&F summary.

### 11. Project BOQ & Billing Module
- Allow detailed BOQ entry per project.
- Create a dedicated module for Vendor Bills and Client Bills.
- Support reconciliation against BOQ work order amounts and quantities.
- Generate P&L and Budget Summary reports per project.

### 12. Subcontractor Billing
Create a separate data entry sheet for subcontractor billing, linked to the BOQ submitted at project initiation.

### 13. Fuel & Machinery Management
- Set minimum fuel efficiency benchmarks per vehicle/machinery.
- Trigger alerts if a vehicle consumes excess fuel without meeting the benchmark.
- Auto-deduct from the hiring bill and deduct from the operator's salary accordingly.

### 14. Project Labour & Expense Summary
- Generate a monthly labour wages summary per project (similar to staff payroll).
- Produce a total monthly expense sheet per project for client billing reference.

### 15. Geo-Fencing for Attendance
Enforce geo-fencing at every project location. Employees can only mark attendance within their assigned geo-fence; other locations should be blocked.

### 16. Cash Transaction Visibility Toggle
Add a toggle in the main menu to hide all cash payment entries and transactions when required.

### 17. Project & Labour ID System
- Assign a unique Project ID for office use.
- Generate a separate Supervisor ID for marking daily wage labour attendance.
- Use AI to auto-calculate wages for daily workers (male/female) based on pre-set rates per project.

### 18. Document & Letter Template System
- Create standard templates for: Offer Letter, Appointment Letter, Work Order, LOI (Subcontractor), Relieving Letter, Transfer Letter, PO, Indent, Service Order, Service Bill, Maintenance Bill, Salary Slip, Suspension Letter.
- Auto-populate templates with employee/project details; apply digital signature for HR documents.
- Allow downloading and attaching signed copies after physical signing.
- Provide a template creation tool for drafting new letter formats and work orders.
- Add a Letters menu under both Recruitment and Project modules.

### 19. Role-Based Permissions (Sub-Module Level)
Define granular role permissions at the sub-module level. Example: Site staff can only access the machinery logbook and diesel readings — they cannot view or edit other machinery details. Apply this principle across all modules.

### 20. System Performance
The system must support 100–150 concurrent users during peak hours (e.g., attendance marking) and 50–60 users during normal operations.

### 21. Approval & Action Tracking
- Display approval/rejection actions inline next to the relevant record (attendance, leave, etc.), showing who took the action and when.
- Add Action and Review buttons across all relevant modules and pages.

### 22. Mobile Compatibility
The full admin portal must be fully functional on Android and iOS devices.

### 23. Payment Transfer Attachments
Add attachment fields on payment transfer records to upload RTGS confirmations and payment success documents for future reference.

---