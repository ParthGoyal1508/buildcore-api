import { Injectable } from '@nestjs/common';
import { PunchRecord, PunchType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { withRlsContext } from '../../common/prisma/rls-context';
import { SitesService } from '../../projects/sites/sites.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { EmployeesService } from '../employees/employees.service';
import { LeaveService } from '../leave/leave.service';
import {
  eachDateInRange,
  parseDateOnly,
  toDateOnly,
} from '../leave/leave-days';
import { computeWorkedHours } from './worked-hours';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly sites: SitesService,
    private readonly leave: LeaveService,
    private readonly referenceData: ReferenceDataService,
  ) {}

  async getMonthHistory(
    caller: Caller,
    month: number,
    year: number,
  ): Promise<AttendanceMonth> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    // Day 0 of the following month is the last day of this one — the standard way
    // to get a month's length without a table of month lengths and a leap-year rule.
    const firstDate = toDateOnly(new Date(Date.UTC(year, month - 1, 1)));
    const lastDate = toDateOnly(new Date(Date.UTC(year, month, 0)));

    const [weeklyOffDay, holidays, leaveDates, punches, shiftDurationHours] =
      await Promise.all([
        this.sites.getWeeklyOffDay(caller.rls, employee.siteId),
        this.sites.getHolidayCalendar(caller.rls, employee.siteId),
        this.leave.getApprovedLeaveDates(
          caller.rls,
          employee.id,
          firstDate,
          lastDate,
        ),
        this.punchesInRange(caller, employee.id, firstDate, lastDate),
        this.referenceData.getShiftDurationHours(employee.shiftId),
      ]);

    const holidaySet = new Set(holidays);
    const punchesByDate = groupByCapturedDate(punches);

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
      };
    });

    return { days };
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
            gte: parseDateOnly(firstDate),
            // Exclusive upper bound at the next day's midnight, so a punch at
            // 23:59 on the last day is included — `lte: lastDate` would compare
            // against that day's *midnight* and silently drop it.
            lt: new Date(parseDateOnly(lastDate).getTime() + 86_400_000),
          },
        },
        orderBy: { capturedAt: 'asc' },
      }),
    );
  }
}

function groupByCapturedDate(
  punches: PunchRecord[],
): Map<string, PunchRecord[]> {
  const byDate = new Map<string, PunchRecord[]>();
  for (const punch of punches) {
    const date = toDateOnly(punch.capturedAt);
    const existing = byDate.get(date);
    if (existing) {
      existing.push(punch);
    } else {
      byDate.set(date, [punch]);
    }
  }
  return byDate;
}
