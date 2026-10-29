# Feature Specification: No Reminders for Disposed Machines, Scrapped Assets or Completed Projects

**Feature Branch**: `049-no-reminders-closed`
**Created**: 2026-10-29
**Status**: Implemented

**Input** (the user, verbatim): "we need to not show the reminders for assets, machines which are scrapped or sold out. Similar for projects which are completed."

## What exploring the codebase found

- **One engine feeds every reminder surface.** `RemindersService` (`src/dashboard/reminders/`) evaluates every `@ReminderRule()` provider on each request. Three surfaces read it: the Reminders page (`GET /dashboard/reminders`), the sidebar badge (`/count`), and the dashboard "Alerts & Reminders" card. The bell's `reminders_due` provider reads it too. The nightly sweep (`evaluateAndEmit`) keeps the `ReminderNotification` ledger from the same evaluation. No email is sent for reminders (036 decision). So filtering a rule's query covers every surface.
- **Registered rules on develop**:
  - `machinery-document-expiry`, `machinery-registration-expiry` and `machinery-service-due` (plant). **None excluded scrapped or sold machines.** The service-schedule list and the equipment register already hid them (2026-10-17), but the rules did not.
  - `projects-document-expiry`, which covers insurance, labour insurance, mining permission, LOI and the other project papers. **No project-status filter.**
  - `projects-bank-guarantee-expiry`, on BGs under a tender that may link to a project. It is filtered by the BG's own status (RUNNING).
  - `company-document-expiry`, which belongs to the company and is not affected.
  - The three asset rules (`project-assets-*`) are still `module_pending` placeholders that produce nothing.
- **`REMINDABLE_STATUSES` (assets) was declared and unit-tested, but nothing read it.** A scrapped asset still showed `expiryAlert` and `inspectionDue` on the register, and was listed under the "inspection due" filter.
- **Alert flags outside the engine**: the equipment register's `expiryAlert` / `alertDocumentTypes`, each equipment document's `expiring`, the register papers' amber/red shading (computed on the web), and the asset register's `expiryAlert`, `inspectionDue` and document `expiring`.
- **Already-raised notifications are not stored copies.** The bell inbox (`Notification`, 036 D6) is a read/unread ledger over computed rows. A row no longer computed is marked `resolvedAt` on the next poll. `ReminderNotification` rows no longer live are closed `resolved` by the next sweep. No retention, CPBG, DWR or site-level reminder exists on develop.

## Requirements

- **FR-001** No reminder (list, badge, dashboard card, bell, nightly ledger) for an equipment document, registration paper or service schedule of a machine whose status is `scrapped` or `sold`.
- **FR-002** No reminder for a project document of a project whose status is `completed`.
- **FR-003** No `expiryAlert`, `alertDocumentTypes`, document `expiring` or `inspectionDue` flag on a scrapped asset, and none on a scrapped or sold machine. The "inspection due" asset filter never lists a scrapped asset.
- **FR-004** Reactivating the record brings its reminders back on the next evaluation, with nothing to restore. For a machine that is a disposal reversed; for a project, any status other than `completed`.
- **FR-005** The web shows no amber/red expiry marks on a disposed machine's or scrapped asset's detail page. The dates stay visible.

## Clarifications (decision log)

### Session 2026-10-29 — decided by implementer; the user asked for no clarification rounds

- Q: Which project statuses silence reminders? → A: `completed` only (`UNREMINDED_PROJECT_STATUSES`). `on_hold` keeps its reminders, and so does `planning`. (decided by implementer, 2026-10-29, on hold is a pause: the site stands, its insurance still covers it and work resumes. A project in planning is gathering exactly the papers worth chasing. There is no other closed state in `ProjectStatus`)
- Q: Do bank guarantees on a completed project stop reminding? → A: No. A BG's reminder follows the BG's own status: Running reminds, while Released and Encashed do not. (decided by implementer, 2026-10-29. A PBG on a completed project is still the company's money and margin at the bank, and its expiry or claim-period end is when it is chased back from the client, which is the reminder that matters most after completion. The register already has the off switch, which is to mark it Released. If the user wants them silenced too, it is one `tender: { project: … }` filter in `bank-guarantee.reminder-rule.ts`)
- Q: Which machine statuses count as disposed? → A: `scrapped` and `sold`, the existing `DISPOSED_STATUSES`. `inactive` and `under_maintenance` keep reminding. (decided by implementer, 2026-10-29, the user named scrapped and sold. A machine parked or in the workshop still needs its insurance and fitness)
- Q: Which asset statuses? → A: Everything outside `REMINDABLE_STATUSES`, which is `scrapped`. Assets have no "sold" status. (decided by implementer, 2026-10-29, the asset module's own FR-027 constant, now actually applied)
- Q: Where is the exclusion applied? → A: In each rule's own query, inside the owning module: plant filters on `Equipment.status`, and projects filters on `Project.status`. The engine is unchanged. (decided by implementer, 2026-10-29. Principle I keeps the rule in the module that owns the data, and every surface reads the same evaluation, so one filter per rule covers the list, the badge, the card, the bell and the ledger)
- Q: What happens to notifications already raised for such records? → A: They are cleared by the existing mechanisms, not by a migration or a new job. The bell row is marked resolved on the caller's next poll, and the `ReminderNotification` ledger row is closed `resolved` by the next nightly sweep. Snoozes are left as they are. (decided by implementer, 2026-10-29. Both stores already treat "no longer computed" as resolved, so a one-off clean-up would duplicate that and could not be undone by a reversal)
- Q: What does a reactivated record get? → A: Its reminders come back on the next evaluation. In the bell, the stored row is un-resolved and keeps its read state. After the 30-day retention it comes back as a new unread row. (decided by implementer, 2026-10-29, nothing is deleted, so nothing needs restoring)
- Q: Do the register and detail pages still show the dates? → A: Yes. The dates and the `expired` fact stay in the API. The alert flags (`expiring`, `expiryAlert`, `inspectionDue`) are false, and the web drops the amber/red marks on a disposed machine or scrapped asset. (decided by implementer, 2026-10-29, the history is the record, while the marks are prompts to act)
- Q: A machine's service-schedule `status` on its detail page (`due_soon` / `overdue`)? → A: Unchanged. It describes the meter, and the services list already hides disposed machines. (decided by implementer, 2026-10-29, not a reminder surface)
- Q: Does the migration change anything? → A: No migration. (decided by implementer, 2026-10-29, query-only change)

## Changes

- `src/plant/reminders/plant-reminder.rules.ts`: all three machinery rules filter `equipment.status notIn DISPOSED_STATUSES`.
- `src/projects/documents/project-document.reminder-rule.ts`: filters `project.status notIn UNREMINDED_PROJECT_STATUSES` (`src/projects/constants/projects.constants.ts`).
- `src/plant/equipment/equipment.service.ts`: `expiryAlert`, `alertDocumentTypes` and document `expiring` are false or empty for a disposed machine.
- `src/assets/asset-status.ts`: `isRemindable()`. `src/assets/register/asset.service.ts`: `expiryAlert`, `inspectionDue` and document `expiring` follow it, and the `inspectionDue` filter is narrowed to `REMINDABLE_STATUSES`.
- `src/dashboard/reminders/unbuilt-module.rules.ts`: the asset placeholders note that the real rules must keep to `REMINDABLE_STATUSES`.
- Web (`buildcore-web` branch `049-no-reminders-closed`): the equipment detail page shows no expiry badges or paper shading when the machine is disposed, and the asset detail page shows no expired/expiring marks when the asset is scrapped.

## Migration

None.

## Verification

- Unit tests:
  - `plant-reminder.rules.spec.ts`: each machinery rule's query excludes scrapped and sold machines, and the project-document rule excludes `completed` projects but not `on_hold`;
  - `asset-status.spec.ts`: `isRemindable`.
- e2e `no-reminders-closed` (5 cases, local scratch DB):
  - everything live reminds: list, bell, ledger and flags;
  - a scrapped machine, then a sold one, drops out of the list and the bell, the sweep closes its ledger row, and its flags clear. Reversal brings all three machinery reminders back and reopens the ledger;
  - a completed project's document drops out and its ledger row closes. On hold it still reminds, and reopened it reminds again;
  - a scrapped asset loses `expiryAlert`, `inspectionDue` and `expiring`, and leaves the inspection-due list, with or without a status filter.
