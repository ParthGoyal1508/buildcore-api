import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext, RlsContext } from '../../common/prisma/rls-context';
import { ReminderRule } from '../../dashboard/reminders/reminder-rule.decorator';
import {
  ReminderCandidate,
  ReminderRuleProvider,
  ReminderSeverityLadder,
} from '../../dashboard/reminders/reminder-rule.types';
import { SERVICE_DUE_SOON_MARGIN } from '../constants/plant.constants';

/** How far back the service-due rule looks to estimate a machine's daily usage. */
const USAGE_WINDOW_DAYS = 30;
/** Longest projection the service-due rule will make. Beyond this the estimate is
 * noise, and a reminder dated eight months out is not a reminder. */
const MAX_PROJECTION_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Equipment document expiry (FR-036 registrant, plan Phase A5).
 *
 * This replaces the `EquipmentDocumentExpiryRule` placeholder that lived in
 * `src/dashboard/reminders/unbuilt-module.rules.ts` while this module did not
 * exist. That placeholder is now deleted: leaving it in place would double-report
 * the rule as both available and pending.
 *
 * The rule is registered by decorating a provider *in this module*, and nothing in
 * `src/dashboard/` changes to accommodate it — that is the whole point of FR-028,
 * and it is why the engine discovers rules rather than importing them.
 *
 * Each document is measured against its own type's configured `alertDays` rather
 * than the rule's declared `leadDays` (006 FR-010): an insurance policy wants six
 * weeks' notice and a pollution certificate a fortnight, and flattening the two into
 * one window is exactly the hardcoded-30-days behaviour research.md §10 corrected.
 * `leadDays` below stays as the catalogue's outer bound and the widest window any
 * doc type may claim.
 */
@ReminderRule()
@Injectable()
export class EquipmentDocumentExpiryRule implements ReminderRuleProvider {
  readonly ruleKey = 'machinery-document-expiry';
  readonly sourceModule = 'machinery';
  readonly type = 'document_expiry';
  readonly entityType = 'EQUIPMENT_DOCUMENT';
  readonly leadDays = 60;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 14 };

  constructor(private readonly prisma: PrismaService) {}

  isAvailable(): boolean {
    return true;
  }

  async evaluate(ctx: RlsContext): Promise<ReminderCandidate[]> {
    const horizon = new Date(Date.now() + this.leadDays * MS_PER_DAY);

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const documents = await tx.equipmentDocument.findMany({
        where: { expiresAt: { not: null, lte: horizon } },
        include: { equipment: { select: { code: true, name: true } } },
      });
      if (documents.length === 0) return [];

      const docTypes = await tx.equipmentDocType.findMany({
        where: {
          id: { in: [...new Set(documents.map((doc) => doc.docTypeId))] },
        },
        select: { id: true, name: true, alertDays: true },
      });
      const byId = new Map(docTypes.map((type) => [type.id, type]));

      return documents.flatMap((document): ReminderCandidate[] => {
        const docType = byId.get(document.docTypeId);
        const expiresAt = document.expiresAt as Date;
        const alertDays = docType?.alertDays ?? 0;
        const window = new Date(Date.now() + alertDays * MS_PER_DAY);
        // Inside its own type's window, or already lapsed. A document that expired
        // last month still needs chasing — more, not less.
        if (expiresAt > window) return [];

        return [
          {
            companyId: document.companyId,
            entityId: document.id,
            subject: `${docType?.name ?? 'Document'} — ${
              document.equipment.code
            } ${document.equipment.name}`,
            dueDate: expiresAt,
            actionLink: `/dashboard/plant/equipment/${document.equipmentId}`,
          },
        ];
      });
    });
  }
}

/**
 * Service schedules coming due (FR-036 registrant, plan Phase A5).
 *
 * Replaces the `EquipmentServiceDueRule` placeholder, for the same reason as above.
 *
 * The awkward part: a service falls due at a *meter reading*, and the reminders
 * engine deals in *dates*. Rather than pretend the two are the same, this rule
 * projects one from the other — it measures how fast the machine has actually been
 * running over the last 30 logbook days and converts the readings remaining into
 * days remaining. A machine that has stood idle produces no projection and is
 * therefore not reminded about, which is correct: an idle machine is not
 * approaching its next service.
 *
 * A schedule already past its due reading is dated today, so it reads as `overdue`
 * rather than as a projection into the past.
 */
@ReminderRule()
@Injectable()
export class EquipmentServiceDueRule implements ReminderRuleProvider {
  readonly ruleKey = 'machinery-service-due';
  readonly sourceModule = 'machinery';
  readonly type = 'service_due';
  readonly entityType = 'EQUIPMENT';
  /** A service is scheduled, not applied for — a fortnight's notice is enough. */
  readonly leadDays = 14;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 3 };

  constructor(private readonly prisma: PrismaService) {}

  isAvailable(): boolean {
    return true;
  }

  async evaluate(ctx: RlsContext): Promise<ReminderCandidate[]> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const schedules = await tx.serviceSchedule.findMany({
        include: {
          equipment: {
            select: {
              id: true,
              code: true,
              name: true,
              currentReading: true,
              meterType: true,
            },
          },
        },
      });
      if (schedules.length === 0) return [];

      const windowStart = new Date(Date.now() - USAGE_WINDOW_DAYS * MS_PER_DAY);
      const usage = await tx.logbookEntry.groupBy({
        by: ['equipmentId'],
        where: {
          equipmentId: {
            in: [...new Set(schedules.map((s) => s.equipmentId))],
          },
          date: { gte: windowStart },
        },
        _sum: { totalHours: true },
      });
      const perDay = new Map(
        usage.map((row) => [
          row.equipmentId,
          Number(row._sum.totalHours ?? 0) / USAGE_WINDOW_DAYS,
        ]),
      );

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return schedules.flatMap((schedule): ReminderCandidate[] => {
        const remaining =
          Number(schedule.nextDueReading) -
          Number(schedule.equipment.currentReading);
        const subject = `${schedule.serviceType} — ${schedule.equipment.code} ${schedule.equipment.name}`;
        const actionLink = `/dashboard/plant/services?equipmentId=${schedule.equipmentId}`;

        if (remaining <= 0) {
          return [
            {
              companyId: schedule.companyId,
              entityId: schedule.id,
              subject: `${subject} (overdue by ${Math.abs(remaining)} ${
                schedule.equipment.meterType
              })`,
              dueDate: today,
              actionLink,
            },
          ];
        }

        const rate = perDay.get(schedule.equipmentId) ?? 0;
        // No recorded usage means no honest projection. Silence beats a guess here:
        // a reminder invented for a machine nobody is running is noise that makes
        // the real ones easier to ignore.
        if (rate <= 0) return [];

        const daysAway = Math.ceil(remaining / rate);
        if (daysAway > MAX_PROJECTION_DAYS) return [];
        // Anything further out than the lead window is not due yet. The reading
        // margin is kept as a floor so a machine within `SERVICE_DUE_SOON_MARGIN`
        // of its service still surfaces even if it has been running slowly.
        if (daysAway > this.leadDays && remaining > SERVICE_DUE_SOON_MARGIN) {
          return [];
        }

        return [
          {
            companyId: schedule.companyId,
            entityId: schedule.id,
            subject: `${subject} (${remaining} ${schedule.equipment.meterType} remaining)`,
            dueDate: new Date(today.getTime() + daysAway * MS_PER_DAY),
            actionLink,
          },
        ];
      });
    });
  }
}
