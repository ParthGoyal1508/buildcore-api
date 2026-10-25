import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MeterType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  type FormFormat,
  type FormRow,
  type RenderedForm,
  fileSafe,
  inr,
  monthLabel,
  qty,
  reading,
  renderFormFile,
  shortDate,
} from '../../common/form-document';
import { businessToday } from '../../common/business-date';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope } from '../../settings/company-scope';
import { FuelService } from '../fuel/fuel.service';
import { PlantRefsService } from '../plant-refs.service';
import type { SaveLogbookSheetDto } from './dto/logbook-sheet.dto';
import { readingProblem } from './logbook-readings';
import { LogbookService } from './logbook.service';

/** One day of the sheet. Readings are null on a day with no logbook entry. */
export interface LogbookSheetDay {
  date: string;
  logbookEntryId: string | null;
  openingReading: number | null;
  closingReading: number | null;
  total: number | null;
  /** Card numbers of the day's fuel draws, joined. */
  cardNo: string | null;
  /** Rupees advanced for diesel that day, and litres drawn — summed over the day's draws. */
  dieselAmount: number | null;
  dieselQuantity: number | null;
}

export interface LogbookSheet {
  equipment: {
    id: string;
    code: string;
    name: string;
    registrationNo: string | null;
    meterType: MeterType;
  };
  month: string;
  days: LogbookSheetDay[];
  /** The last closing reading before the month — what the 1st's opening should be. */
  carriedReading: number | null;
  totals: { dieselAmount: number; dieselQuantity: number; total: number };
  /**
   * The month's average: km per litre on a km meter (the format's 16.20), litres per hour on
   * an hour meter. Null until both distance and diesel exist.
   */
  average: number | null;
  averageUnit: 'km/l' | 'l/hr';
}

const MONTH = /^(\d{4})-(\d{2})$/;

/**
 * The Vehicle Log Book and Diesel Report Sheet (2026-10-15) — the client's "Monthly Status of
 * Vehicle No.-MH21-5359": a row for every day of the month with the fuel card, the diesel advance
 * in rupees and litres, the opening and closing reading and the day's run, totalled, with the
 * month's average beside them.
 *
 * It is a view over what the plant module already records, not a second store: the readings are
 * the logbook's and the diesel is the fuel register's. Entering a row on the sheet creates the
 * logbook entry and the fuel entry through their own services, so utilisation, the machine's
 * current reading and the fuel variance check all run exactly as they do for a single entry.
 */
@Injectable()
export class LogbookSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: PlantRefsService,
    private readonly logbook: LogbookService,
    private readonly fuel: FuelService,
  ) {}

  async month(
    caller: AuthenticatedUser,
    equipmentId: string,
    month: string,
  ): Promise<LogbookSheet> {
    const range = this.range(month);
    const found = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const equipment = await tx.equipment.findUnique({
          where: { id: equipmentId },
          select: {
            id: true,
            companyId: true,
            code: true,
            name: true,
            registrationNo: true,
            meterType: true,
          },
        });
        if (!equipment) throw new NotFoundException('Equipment not found');
        assertInScope(caller, equipment, 'Equipment');
        const between = { gte: range.from, lte: range.to };
        const [entries, fuel, before] = await Promise.all([
          tx.logbookEntry.findMany({
            where: { equipmentId, date: between },
            orderBy: { date: 'asc' },
          }),
          tx.fuelEntry.findMany({
            where: { equipmentId, date: between },
            orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
          }),
          tx.logbookEntry.findFirst({
            where: { equipmentId, date: { lt: range.from } },
            orderBy: { date: 'desc' },
            select: { closingReading: true },
          }),
        ]);
        return { equipment, entries, fuel, before };
      },
    );

    const entryByDay = new Map(
      found.entries.map((e) => [e.date.toISOString().slice(0, 10), e]),
    );
    const fuelByDay = new Map<string, typeof found.fuel>();
    for (const draw of found.fuel) {
      const day = draw.date.toISOString().slice(0, 10);
      fuelByDay.set(day, [...(fuelByDay.get(day) ?? []), draw]);
    }

    const days: LogbookSheetDay[] = range.days.map((date) => {
      const entry = entryByDay.get(date);
      const draws = fuelByDay.get(date) ?? [];
      const cards = [
        ...new Set(draws.flatMap((d) => (d.cardNo ? [d.cardNo] : []))),
      ];
      return {
        date,
        logbookEntryId: entry?.id ?? null,
        openingReading: entry ? Number(entry.openingReading) : null,
        closingReading: entry ? Number(entry.closingReading) : null,
        total: entry ? Number(entry.totalHours) : null,
        cardNo: cards.length ? cards.join(', ') : null,
        dieselAmount: draws.length
          ? round(
              draws.reduce((s, d) => s + Number(d.amount), 0),
              2,
            )
          : null,
        dieselQuantity: draws.length
          ? round(
              draws.reduce((s, d) => s + Number(d.quantity), 0),
              3,
            )
          : null,
      };
    });

    const totals = {
      dieselAmount: round(sum(days.map((d) => d.dieselAmount)), 2),
      dieselQuantity: round(sum(days.map((d) => d.dieselQuantity)), 3),
      total: round(sum(days.map((d) => d.total)), 3),
    };
    const km = found.equipment.meterType === MeterType.km;
    const average =
      totals.total > 0 && totals.dieselQuantity > 0
        ? round(
            km
              ? totals.total / totals.dieselQuantity
              : totals.dieselQuantity / totals.total,
            2,
          )
        : null;

    return {
      equipment: {
        id: found.equipment.id,
        code: found.equipment.code,
        name: found.equipment.name,
        registrationNo: found.equipment.registrationNo,
        meterType: found.equipment.meterType,
      },
      month,
      days,
      carriedReading: found.before ? Number(found.before.closingReading) : null,
      totals,
      average,
      averageUnit: km ? 'km/l' : 'l/hr',
    };
  }

  /**
   * Records the rows entered on the sheet. A row with readings becomes the day's logbook entry;
   * a row with diesel becomes a fuel entry. A day that already has its logbook entry keeps it —
   * the sheet refuses to write a second one rather than silently replacing a reading that other
   * figures were computed from. Everything is checked before anything is written.
   */
  async save(
    caller: AuthenticatedUser,
    dto: SaveLogbookSheetDto,
    ipAddress: string,
  ): Promise<LogbookSheet> {
    const current = await this.month(caller, dto.equipmentId, dto.month);
    const known = new Map(current.days.map((d) => [d.date, d]));

    for (const row of dto.rows) {
      const day = known.get(row.date.slice(0, 10));
      if (!day) {
        throw new BadRequestException(
          `${row.date} is not a day of ${monthLabel(dto.month)}.`,
        );
      }
      const hasReading =
        row.openingReading !== undefined || row.closingReading !== undefined;
      if (hasReading) {
        if (
          row.openingReading === undefined ||
          row.closingReading === undefined
        ) {
          throw new BadRequestException(
            `${shortDate(
              day.date,
            )}: give both the starting and the closing reading.`,
          );
        }
        if (row.closingReading < row.openingReading) {
          throw new BadRequestException(
            `${shortDate(
              day.date,
            )}: the closing reading is below the starting one.`,
          );
        }
        if (day.logbookEntryId) {
          throw new ConflictException(
            `${shortDate(
              day.date,
            )} already has its readings. Correct them from the Logbook (Correct readings).`,
          );
        }
      }
      const hasDiesel =
        row.dieselQuantity !== undefined || row.dieselAmount !== undefined;
      if (
        hasDiesel &&
        (!row.dieselQuantity || row.dieselAmount === undefined)
      ) {
        throw new BadRequestException(
          `${shortDate(
            day.date,
          )}: give both the diesel advance and the litres.`,
        );
      }
    }

    // 036 K4, checked for every row before any is written — the readings rule `LogbookService`
    // applies per entry, walked across the month so each typed day is compared with the closing
    // reading before it, whether that was saved earlier or typed on this sheet.
    const typed = new Map(
      dto.rows
        .filter(
          (row) =>
            row.openingReading !== undefined &&
            row.closingReading !== undefined,
        )
        .map((row) => [row.date.slice(0, 10), row]),
    );
    const today = businessToday();
    let previousClosing = current.carriedReading;
    for (const day of current.days) {
      const row = typed.get(day.date);
      if (row) {
        const problem = readingProblem({
          date: shortDate(day.date),
          dateValue: new Date(`${day.date}T00:00:00.000Z`),
          today,
          meterType: current.equipment.meterType,
          openingReading: row.openingReading as number,
          closingReading: row.closingReading as number,
          previousClosing,
          readingGapReason: row.readingGapReason,
        });
        if (problem) throw new BadRequestException(problem);
        previousClosing = row.closingReading as number;
      } else if (day.closingReading !== null) {
        previousClosing = day.closingReading;
      }
    }

    // Review decision 9: a typed day inside a verified or paid hire bill refuses the whole sheet,
    // checked here so nothing is written before the refusal.
    await this.logbook.assertDaysNotBilled(caller, dto.equipmentId, [
      ...typed.keys(),
    ]);

    // One transaction for the whole sheet (042). The pre-checks above already refuse
    // everything the reading rules and billed periods can refuse before a single write;
    // this makes the rest — a machine disposed mid-save, a fuel refusal, a database fault
    // on row 19 — atomic too, so a failed save leaves no half-written month. Readings
    // first, so the fuel entries that follow find the day's logbook entry in the same
    // transaction and their variance is computed against it.
    const written = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const entries = [];
        for (const row of [...dto.rows].sort((a, b) =>
          a.date.localeCompare(b.date),
        )) {
          if (
            row.openingReading !== undefined &&
            row.closingReading !== undefined
          ) {
            entries.push(
              await this.logbook.createInTx(
                caller,
                {
                  equipmentId: dto.equipmentId,
                  date: row.date,
                  openingReading: row.openingReading,
                  closingReading: row.closingReading,
                  ...(row.dieselQuantity
                    ? { fuelConsumed: row.dieselQuantity }
                    : {}),
                  ...(row.readingGapReason
                    ? { readingGapReason: row.readingGapReason }
                    : {}),
                },
                tx,
              ),
            );
          }
        }
        const fills = [];
        for (const row of dto.rows) {
          if (row.dieselQuantity && row.dieselAmount !== undefined) {
            fills.push(
              await this.fuel.createInTx(
                caller,
                {
                  equipmentId: dto.equipmentId,
                  date: row.date,
                  quantity: row.dieselQuantity,
                  amount: row.dieselAmount,
                  cardNo: row.cardNo,
                },
                tx,
              ),
            );
          }
        }
        return { entries, fills };
      },
    );

    // Audits and variance events only after the commit: an audit entry or an alert for a
    // row that rolled back would describe something that never happened.
    for (const entry of written.entries) {
      await this.logbook.auditCreated(caller, entry, ipAddress);
    }
    for (const fill of written.fills) {
      await this.fuel.recordCreated(caller, fill, ipAddress);
    }
    return this.month(caller, dto.equipmentId, dto.month);
  }

  async document(
    caller: AuthenticatedUser,
    equipmentId: string,
    month: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const sheet = await this.month(caller, equipmentId, month);
    const companyId = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) =>
        (
          await tx.equipment.findUniqueOrThrow({
            where: { id: equipmentId },
            select: { companyId: true },
          })
        ).companyId,
    );
    const company = await this.refs.documentCompany(companyId);
    const vehicle = sheet.equipment.registrationNo ?? sheet.equipment.code;
    const km = sheet.equipment.meterType === MeterType.km;

    const rows: FormRow[] = sheet.days.map((day, index) => {
      const row: FormRow = [
        String(index + 1),
        shortDate(day.date),
        day.cardNo ?? '',
        day.dieselAmount === null ? '' : inr(day.dieselAmount, 0),
        day.dieselQuantity === null ? '' : qty(day.dieselQuantity, 2),
        reading(day.openingReading),
        reading(day.closingReading),
        day.total === null ? '' : qty(day.total, 2),
      ];
      // The month's average, once, down the whole column — as the format draws it.
      if (index === 0) {
        row.push({
          text: sheet.average === null ? '' : sheet.average.toFixed(2),
          rowSpan: sheet.days.length,
          large: true,
        });
      }
      return row;
    });

    return renderFormFile(
      {
        company,
        title: 'Vehicle Log Book and Diesel Report Sheet',
        caption: `${sheet.equipment.name} · ${
          sheet.equipment.code
        } · ${monthLabel(month)}`,
        accent: 'plain',
        sheetName: monthLabel(month),
        footer: km
          ? 'Total is the day’s run in km; Average is km per litre over the month.'
          : 'Total is the day’s running hours; Average is litres per hour over the month.',
        blocks: [
          {
            kind: 'table',
            caption: `Monthly Status of Vehicle No.-${vehicle}  ( ${sheet.equipment.name} )`,
            fontSize: 8,
            columns: [
              { label: 'Sr. No.', width: 4.5, align: 'center' },
              { label: 'Date', width: 8.5, align: 'center' },
              { label: 'Card no.', width: 15, align: 'center' },
              { label: 'Diesel Advance', width: 8, align: 'right' },
              { label: 'Diesel Quantity', width: 8, align: 'right' },
              {
                label: km ? 'Starting Reading' : 'Starting Hours',
                width: 9,
                align: 'right',
              },
              {
                label: km ? 'Closing Reading' : 'Closing Hours',
                width: 9,
                align: 'right',
              },
              { label: 'Total', width: 8, align: 'right' },
              { label: 'Average', width: 8, align: 'center' },
            ],
            rows,
            foot: [
              [
                { text: 'Total Diesel', span: 3, align: 'right', large: true },
                {
                  text: inr(sheet.totals.dieselAmount, 0),
                  large: true,
                  align: 'right',
                },
                {
                  text: qty(sheet.totals.dieselQuantity, 2),
                  large: true,
                  align: 'right',
                },
                { text: '', span: 2 },
                {
                  text: qty(sheet.totals.total, 2),
                  large: true,
                  align: 'right',
                },
                '',
              ],
            ],
          },
        ],
      },
      format,
      fileSafe(`Log Book ${vehicle} ${month}`),
    );
  }

  private range(month: string) {
    const match = MONTH.exec(month);
    if (!match) throw new BadRequestException('Month must be YYYY-MM.');
    const year = Number(match[1]);
    const m = Number(match[2]);
    if (m < 1 || m > 12)
      throw new BadRequestException('Month must be YYYY-MM.');
    const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const days = Array.from(
      { length: count },
      (_, i) => `${match[1]}-${match[2]}-${String(i + 1).padStart(2, '0')}`,
    );
    return {
      from: new Date(`${days[0]}T00:00:00.000Z`),
      to: new Date(`${days[count - 1]}T00:00:00.000Z`),
      days,
    };
  }
}

function sum(values: (number | null)[]): number {
  return values.reduce<number>((s, v) => s + (v ?? 0), 0);
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
