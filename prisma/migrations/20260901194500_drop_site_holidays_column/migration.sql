-- Contract phase of the Holiday migration (005 T015, research.md §6).
--
-- The expand phase ran in 20260901192829_hr_payroll_entities, copying any
-- Site.holidays entries into hr.Holiday / hr.HolidaySite. The reading code
-- (attendance-history.service.ts, leave.service.ts) now resolves holidays through
-- HolidaysService, and SitesService.getHolidayCalendar has been removed, so nothing
-- reads this column any more.
--
-- Verified before dropping: the only Site row holds an empty array, so no holiday
-- data is lost. Prisma counts a non-null empty array as data and therefore warns.
--
-- Hand-written rather than generated: `prisma migrate dev` insists on an
-- interactive confirmation for any column drop it considers lossy, which cannot be
-- answered in a non-interactive environment.

ALTER TABLE "projects"."Site" DROP COLUMN "holidays";
