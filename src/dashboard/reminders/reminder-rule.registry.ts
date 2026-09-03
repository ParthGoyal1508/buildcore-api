import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../../common/prisma/rls-context';
import { REMINDER_RULE_METADATA } from './reminder-rule.decorator';
import { ReminderRuleProvider } from './reminder-rule.types';

/**
 * Finds every `@ReminderRule()` provider in the application and keeps the
 * `ReminderRule` table in step with what it finds.
 *
 * Discovery, not injection — see the comment on `@ReminderRule()` for why a
 * multi-provider token cannot deliver FR-028's "no edit to this feature" guarantee.
 *
 * The rules themselves are code. The table is their mirror, and it earns its place by
 * giving an operator one queryable list of what the engine will evaluate, plus an
 * `enabled` flag that silences a misbehaving rule without a deploy.
 *
 * Sync, not seed: it runs on every boot and upserts, so a changed lead window in code
 * reaches the table without a migration. It deliberately does NOT overwrite
 * `enabled` — that column is the operator's, and a redeploy quietly re-enabling a
 * rule someone had switched off would be the worst kind of surprise.
 *
 * Rules that vanish from code are marked disabled rather than deleted, because
 * `ReminderSnooze` and `ReminderNotification` both reference `ruleKey` and a delete
 * would cascade away history that is still worth reading.
 */
@Injectable()
export class ReminderRuleRegistry implements OnModuleInit {
  private readonly logger = new Logger(ReminderRuleRegistry.name);
  private discovered: ReminderRuleProvider[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: DiscoveryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.discovered = this.discover();
    this.assertKeysUnique(this.discovered);
    await this.sync();
  }

  /** Every rule registered anywhere in the application. */
  rules(): ReminderRuleProvider[] {
    return this.discovered;
  }

  private discover(): ReminderRuleProvider[] {
    return this.discovery
      .getProviders()
      .filter((wrapper) => {
        const { instance, metatype } = wrapper;
        if (!instance || !metatype) return false;
        return Reflect.getMetadata(REMINDER_RULE_METADATA, metatype) === true;
      })
      .map((wrapper) => wrapper.instance as ReminderRuleProvider);
  }

  /**
   * Two rules sharing a `ruleKey` would collide on the table's unique index and,
   * worse, would share a de-duplication ledger — one rule's emitted notification
   * would suppress the other's. Caught at boot with both offenders named, rather
   * than at 06:30 as a constraint violation in a cron log.
   */
  private assertKeysUnique(providers: ReminderRuleProvider[]): void {
    const seen = new Map<string, string>();
    for (const provider of providers) {
      const previous = seen.get(provider.ruleKey);
      if (previous) {
        throw new Error(
          `Duplicate reminder ruleKey "${provider.ruleKey}": registered by both ` +
            `${previous} and ${provider.constructor.name}.`,
        );
      }
      seen.set(provider.ruleKey, provider.constructor.name);
    }
  }

  /** Upserts every declared rule; disables catalogue rows no longer backed by code. */
  async sync(): Promise<void> {
    const declared = this.discovered;

    await withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
      for (const provider of declared) {
        const declaration = {
          sourceModule: provider.sourceModule,
          type: provider.type,
          entityType: provider.entityType,
          leadDays: provider.leadDays,
          severityLadder:
            provider.severityLadder as unknown as Prisma.InputJsonValue,
        };
        await tx.reminderRule.upsert({
          where: { ruleKey: provider.ruleKey },
          // `enabled` is absent from the update on purpose, and defaults to true
          // only on first insert — see the class comment.
          create: { ruleKey: provider.ruleKey, ...declaration },
          update: declaration,
        });
      }

      const orphaned = await tx.reminderRule.updateMany({
        where: {
          enabled: true,
          ruleKey: { notIn: declared.map((p) => p.ruleKey) },
        },
        data: { enabled: false },
      });
      if (orphaned.count > 0) {
        this.logger.warn(
          `${orphaned.count} reminder rule(s) disabled: no longer declared in code.`,
        );
      }
    });

    this.logger.log(
      `${declared.length} reminder rule(s) discovered ` +
        `(${declared.filter((p) => p.isAvailable()).length} available).`,
    );
  }
}
