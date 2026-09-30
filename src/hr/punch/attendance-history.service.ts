import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PunchRecord, PunchType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { SitesService } from '../../projects/sites/sites.service';
import { HolidaysService } from '../holidays/holidays.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { EmployeesService } from '../employees/employees.service';
import { LeaveService } from '../leave/leave.service';
import {
  eachDateInRange,
  parseDateOnly,
  toDateOnly,
  zonedDateOnly,
  zonedDayBounds,
} from '../leave/leave-days';
import { computeWorkedHours } from './worked-hours';
import { ACTOR_NAME_SELECT, actorNameOf } from '../../common/actor-name';

export type AttendanceStatus =
  | 'present'
  | 'absent'
  | 'on_leave'
  | 'weekly_off'
  | 'holiday';

export interface AttendanceDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** 0 = Sunday, matching `Site.weeklyOffDay`. */
  dayOfWeek: number;
  inTime: string | null;
  outTime: string | null;
  otHours: number | null;
  status: AttendanceStatus;
  /**
   * Who changed this day, and to what (016 FR-012c) — the client's *"it should also
   * reflect in the attendance of the affected employee"*.
   *
   * A **property of the day**, not a notification: there is no dismiss, no seen state and
   * nothing to clear. A record of somebody else altering your attendance that can be
   * cleared is one that disappears the first time it is inconvenient.
   *
   * Empty for an unmodified day, so the field is always present and a client never has to
   * distinguish absent from empty.
   */
  modifications: DayModification[];
}

/** One recorded change to one day, as the affected employee sees it (016 FR-012c). */
export interface DayModification {
  /**
   * The actor's **name**, never their id. The requirement is that the employee can see who
   * changed their attendance, and a cuid does not tell them that.
   */
  actorName: string;
  at: string;
  before: unknown;
  after: unknown;
  /**
   * Free text, and worth knowing: it was written by an administrator who did not
   * necessarily know the employee would read it (016 T069). No code change follows from
   * that — it is recorded here once rather than discovered through a complaint.
   */
  reason: string | null;
}

export interface AttendanceMonth {
  days: AttendanceDay[];
}

/** The inputs a single day's status is decided from, with no database or clock in
 * sight — see `statusForDay` below. */
export interface DayFacts {
  dayOfWeek: number;
  weeklyOffDay: number;
  isHoliday: boolean;
  isOnApprovedLeave: boolean;
  hasPunch: boolean;
}

/**
 * The per-day attendance rule (research.md §6), as a pure function.
 *
 * Order matters and is not arbitrary. A punch outranks everything: a worker who
 * actually turned up on a holiday was present, and reporting them as "holiday"
 * would erase the day they worked. Approved leave outranks the calendar for the
 * mirror-image reason — leave the employee was charged for should read as leave,
 * not as a weekly off that cost them nothing. Only when none of that applies, and
 * the day was a working day with no punch, is the employee absent.
 */
export function statusForDay(facts: DayFacts): AttendanceStatus {
  if (facts.hasPunch) {
    return 'present';
  }
  if (facts.isOnApprovedLeave) {
    return 'on_leave';
  }
  if (facts.isHoliday) {
    return 'holiday';
  }
  if (facts.dayOfWeek === facts.weeklyOffDay) {
    return 'weekly_off';
  }
  return 'absent';
}

/**
 * One employee-month of attendance (US3).
 *
 * Computed on read from punches, approved leave, and the site calendar rather than
 * stored as its own table — a second copy of "what happened that day" drifts from
 * the first the moment an approval lands after it was last written (research.md §6).
 */
@Injectable()
export class AttendanceHistoryService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly sites: SitesService,
    private readonly holidays: HolidaysService,
    private readonly leave: LeaveService,
    private readonly referenceData: ReferenceDataService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  async getMonthHistory(
    caller: Caller,
    month: number,
    year: number,
  ): Promise<AttendanceMonth> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    return this.monthFor(caller, employee, month, year);
  }

  /**
   * The same month computation for an employee named by an admin or by payroll
   * (005 US3/US5).
   *
   * Shares `monthFor` with the self-service path rather than reimplementing day
   * status. Payroll deciding "present" differently from the employee's own
   * attendance screen is precisely the drift research.md §6 warns about.
   */
  async getMonthForEmployee(
    caller: Caller,
    employee: {
      id: string;
      siteId: string;
      shiftId: string;
      companyId: string;
    },
    month: number,
    year: number,
  ): Promise<AttendanceMonth> {
    return this.monthFor(caller, employee, month, year);
  }

  /**
   * One date's status for many employees at once (005 FR-069, FR-070).
   *
   * The admin Daily Register needs the same per-day verdict the employee's own
   * history screen renders, for a whole company at once. It calls this rather
   * than deriving its own, because a second implementation of `statusForDay`'s
   * ordering is exactly the drift `getMonthForEmployee` above is commented
   * against — and the register is the screen an admin trusts when the employee
   * disputes a day.
   *
   * `hasPunch` is supplied by the caller rather than queried here: the register
   * has already fetched the day's punches to render In and Out times, and asking
   * the database for them a second time to answer a question the caller can
   * already answer would be wasteful.
   *
   * Site facts are fetched per *distinct site*, not per employee — a company with
   * two hundred employees across four sites makes four pairs of lookups, not two
   * hundred.
   */
  async statusesForDate(
    caller: Caller,
    companyId: string,
    employees: { id: string; siteId: string }[],
    date: string,
    hasPunch: (employeeId: string) => boolean,
  ): Promise<Map<string, AttendanceStatus>> {
    if (employees.length === 0) return new Map();

    const siteIds = [...new Set(employees.map((e) => e.siteId))];

    const [siteFacts, onLeave] = await Promise.all([
      Promise.all(
        siteIds.map(async (siteId) => {
          const [weeklyOffDay, holidays] = await Promise.all([
            this.sites.getWeeklyOffDay(caller.rls, siteId),
            this.holidays.getHolidayCalendar(caller.rls, companyId, siteId),
          ]);
          return [
            siteId,
            { weeklyOffDay, isHoliday: holidays.includes(date) },
          ] as const;
        }),
      ),
      this.leave.getEmployeesOnApprovedLeave(
        caller.rls,
        employees.map((e) => e.id),
        date,
      ),
    ]);

    const bySite = new Map(siteFacts);
    const dayOfWeek = parseDateOnly(date).getUTCDay();

    return new Map(
      employees.map((employee) => {
        const site = bySite.get(employee.siteId);
        return [
          employee.id,
          statusForDay({
            dayOfWeek,
            // A site whose weekly off is unreadable must not silently become
            // Sunday for everyone posted there; -1 matches no day, so those
            // employees fall through to the punch/leave/holiday rules instead of
            // being reported off on a day they may have worked.
            weeklyOffDay: site ? site.weeklyOffDay : -1,
            isHoliday: site ? site.isHoliday : false,
            isOnApprovedLeave: onLeave.has(employee.id),
            hasPunch: hasPunch(employee.id),
          }),
        ];
      }),
    );
  }

  private async monthFor(
    caller: Caller,
    employee: {
      id: string;
      siteId: string;
      shiftId: string;
      companyId: string;
    },
    month: number,
    year: number,
  ): Promise<AttendanceMonth> {
    // Day 0 of the following month is the last day of this one — the standard way
    // to get a month's length without a table of month lengths and a leap-year rule.
    const firstDate = toDateOnly(new Date(Date.UTC(year, month - 1, 1)));
    const lastDate = toDateOnly(new Date(Date.UTC(year, month, 0)));

    const [
      weeklyOffDay,
      holidays,
      leaveDates,
      punches,
      shiftDurationHours,
      modificationsByDate,
    ] = await Promise.all([
      this.sites.getWeeklyOffDay(caller.rls, employee.siteId),
      this.holidays.getHolidayCalendar(
        caller.rls,
        employee.companyId,
        employee.siteId,
      ),
      this.leave.getApprovedLeaveDates(
        caller.rls,
        employee.id,
        firstDate,
        lastDate,
      ),
      this.punchesInRange(caller, employee.id, firstDate, lastDate),
      this.referenceData.getShiftDurationHours(employee.shiftId),
      // One query for the whole month (016 FR-012c, T065). Never one per day: the
      // month is 28-31 days and `@@index([employeeId, date])` is already the access
      // path, so per-day lookups would be the same N+1 this file's Risks note warns
      // about for `statesOf`.
      this.modificationsForRange(employee.id, firstDate, lastDate),
    ]);

    const holidaySet = new Set(holidays);
    const punchesByDate = groupByCapturedDate(punches, this.timeZone);

    const days = eachDateInRange(firstDate, lastDate).map((date) => {
      const dayPunches = punchesByDate.get(date) ?? [];
      const firstIn =
        dayPunches.find((p) => p.type === PunchType.in)?.capturedAt ?? null;
      // Last, not first: an employee who punched out for lunch and back in again
      // finished at the later time, and reporting the earlier one would understate
      // the day.
      const lastOut =
        [...dayPunches].reverse().find((p) => p.type === PunchType.out)
          ?.capturedAt ?? null;

      return {
        date,
        dayOfWeek: parseDateOnly(date).getUTCDay(),
        inTime: firstIn?.toISOString() ?? null,
        outTime: lastOut?.toISOString() ?? null,
        // Overtime needs both ends of the day; an open punch-in has no measurable
        // duration yet, so it reports null rather than a misleading zero.
        otHours:
          firstIn && lastOut
            ? computeWorkedHours(firstIn, lastOut, shiftDurationHours).otHours
            : null,
        status: statusForDay({
          dayOfWeek: parseDateOnly(date).getUTCDay(),
          weeklyOffDay,
          isHoliday: holidaySet.has(date),
          isOnApprovedLeave: leaveDates.has(date),
          hasPunch: dayPunches.length > 0,
        }),
        // Always present, empty when nothing touched the day — so no client has to tell
        // an absent field from an empty one.
        modifications: modificationsByDate.get(date) ?? [],
      };
    });

    return { days };
  }

  /**
   * Every recorded change to this employee's days in a range, grouped by date
   * (016 FR-012c).
   *
   * Two queries, not one per day and not one per modification: the modifications, then the
   * distinct actors. Runs as system rather than under the caller's context, because the
   * caller here is the **employee** — `hr.AttendanceModification` has no RLS policy of its
   * own and `shared.User` is another schema; what bounds the read is `employeeId`, which is
   * resolved from the caller's own user id upstream and is not something they supply.
   */
  private async modificationsForRange(
    employeeId: string,
    firstDate: string,
    lastDate: string,
  ): Promise<Map<string, DayModification[]>> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.attendanceModification.findMany({
          where: {
            employeeId,
            date: {
              gte: parseDateOnly(firstDate),
              lte: parseDateOnly(lastDate),
            },
          },
          orderBy: { createdAt: 'asc' },
        }),
    );
    if (rows.length === 0) return new Map();

    const actors = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.actorUserId))] } },
          select: ACTOR_NAME_SELECT,
        }),
    );
    const names = new Map(actors.map((u) => [u.id, actorNameOf(u)]));

    const byDate = new Map<string, DayModification[]>();
    for (const row of rows) {
      const key = toDateOnly(row.date);
      const list = byDate.get(key) ?? [];
      list.push({
        // Falls back to the id only if the actor row has vanished entirely. A blank name
        // would read as "nobody changed it", which is the opposite of the truth.
        actorName: names.get(row.actorUserId) ?? row.actorUserId,
        at: row.createdAt.toISOString(),
        before: row.before,
        after: row.after,
        reason: row.reason,
      });
      byDate.set(key, list);
    }
    return byDate;
  }

  private async punchesInRange(
    caller: Caller,
    employeeId: string,
    firstDate: string,
    lastDate: string,
  ): Promise<PunchRecord[]> {
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findMany({
        where: {
          employeeId,
          capturedAt: {
            // Local midnights, not UTC ones: the rows are instants, and the month
            // being asked for is the employee's, so its edges have to be measured
            // in their zone or the first and last days lose punches to the
            // neighbouring months.
            gte: zonedDayBounds(firstDate, this.timeZone).start,
            // Exclusive upper bound at the next day's local midnight, so a punch
            // at 23:59 on the last day is included.
            lt: zonedDayBounds(lastDate, this.timeZone).end,
          },
        },
        orderBy: { capturedAt: 'asc' },
      }),
    );
  }
}

function groupByCapturedDate(
  punches: PunchRecord[],
  timeZone: string,
): Map<string, PunchRecord[]> {
  const byDate = new Map<string, PunchRecord[]>();
  for (const punch of punches) {
    // The employee's calendar day, not the server's. `capturedAt` is an instant;
    // which date it belongs to depends on the zone (see `zonedDateOnly`).
    const date = zonedDateOnly(punch.capturedAt, timeZone);
    const existing = byDate.get(date);
    if (existing) {
      existing.push(punch);
    } else {
      byDate.set(date, [punch]);
    }
  }
  return byDate;
}
