import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../common/prisma/rls-context';
import {
  APPROVAL_RECONCILER_METADATA,
  ApprovalReconciler,
} from './approval-reconciler';
import { LIVE_STATES } from './approval.types';

/** One thing the sweep found worth a person's attention. */
export interface ReconciliationFinding {
  kind: 'orphaned' | 'drifted' | 'unreconcilable';
  companyId: string;
  entityType: string;
  entityId: string;
  instanceId: string;
  state: string;
  detail: string;
}

/** What one sweep saw. */
export interface ReconciliationReport {
  scanned: number;
  /** Entity types with live instances and no registered reconciler. */
  unreconciledTypes: string[];
  findings: ReconciliationFinding[];
}

/**
 * The reconciliation sweep (016 T052, research.md §1 and §8).
 *
 * Two faults, one job, because they are the same fault seen from two sides. **Orphans**
 * are approvals whose item has gone — the price of having no foreign key into seven other
 * schemas. **Drift** is an item whose own status lags the spine's — the price of the
 * decision and the item's status being two writes that cannot share a transaction without
 * breaking the boundary this design exists to hold. Splitting them into two jobs would
 * mean two crons, two reports and two chances to look at only one.
 *
 * It **reports**. It does not repair. Repair means either deleting an approval record or
 * writing into another module's schema, and the first destroys evidence while the second
 * is the violation the whole feature is arranged to avoid. What a person does with the
 * report — call `abandon`, replay the completion event, fix the module — is a decision
 * with context this job does not have.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: DiscoveryService,
  ) {}

  /** Every reconciler registered anywhere in the application, by entity type. */
  private reconcilers(): Map<string, ApprovalReconciler> {
    const found = new Map<string, ApprovalReconciler>();
    for (const wrapper of this.discovery.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      if (
        Reflect.getMetadata(APPROVAL_RECONCILER_METADATA, metatype) !== true
      ) {
        continue;
      }
      const reconciler = instance as ApprovalReconciler;
      const previous = found.get(reconciler.entityType);
      if (previous) {
        // Two reconcilers for one entity type would each see half the picture and
        // disagree about the other half. Loud at boot beats silent at 02:00.
        throw new Error(
          `Two approval reconcilers claim entityType "${reconciler.entityType}": ` +
            `${previous.constructor.name} and ${reconciler.constructor.name}.`,
        );
      }
      found.set(reconciler.entityType, reconciler);
    }
    return found;
  }

  /**
   * Sweeps every live approval and reports what does not add up.
   *
   * Runs as a system job: `{ isSuperAdmin: true }` is correct here and is not a shortcut
   * — the sweep is cross-tenant by definition, nobody is asking, and it reads only the
   * spine's own tables. The per-company grouping below is what keeps each module's
   * reconciler scoped to one tenant at a time, so a module cannot be handed ids from a
   * company it should never see.
   */
  async sweep(): Promise<ReconciliationReport> {
    const reconcilers = this.reconcilers();

    const instances = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.approvalInstance.findMany({
          where: { state: { in: LIVE_STATES } },
          select: {
            id: true,
            companyId: true,
            entityType: true,
            entityId: true,
            state: true,
            subject: true,
          },
        }),
    );

    const report: ReconciliationReport = {
      scanned: instances.length,
      unreconciledTypes: [],
      findings: [],
    };

    // Grouped by (company, entityType) so each reconciler is called once per tenant with
    // a batch, rather than once per item.
    const groups = new Map<string, typeof instances>();
    for (const instance of instances) {
      const key = `${instance.companyId}|${instance.entityType}`;
      const group = groups.get(key) ?? [];
      group.push(instance);
      groups.set(key, group);
    }

    const unreconciled = new Set<string>();

    for (const [key, group] of groups) {
      const [companyId, entityType] = key.split('|');
      const reconciler = reconcilers.get(entityType);

      if (!reconciler) {
        // Reported rather than skipped silently. An entity type with live approvals and
        // nobody able to vouch for them is itself the finding: it means a module put work
        // into the spine and never taught the spine how to check on it.
        unreconciled.add(entityType);
        continue;
      }

      const byId = new Map(group.map((i) => [i.entityId, i]));
      const spineStates = new Map(group.map((i) => [i.entityId, i.state]));

      let answers;
      try {
        answers = await reconciler.reconcile(
          companyId,
          [...byId.keys()],
          spineStates,
        );
      } catch (error) {
        // One module's failure must not end the sweep. The remaining modules' drift is
        // still worth finding, and a sweep that reports nothing because the first
        // reconciler threw is indistinguishable from a clean run.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Reconciler for "${entityType}" failed for company ${companyId}: ${reason}`,
        );
        for (const instance of group) {
          report.findings.push({
            kind: 'unreconcilable',
            companyId,
            entityType,
            entityId: instance.entityId,
            instanceId: instance.id,
            state: instance.state,
            detail: `The owning module could not be asked: ${reason}`,
          });
        }
        continue;
      }

      for (const answer of answers) {
        const instance = byId.get(answer.entityId);
        if (!instance) continue;

        if (!answer.exists) {
          report.findings.push({
            kind: 'orphaned',
            companyId,
            entityType,
            entityId: answer.entityId,
            instanceId: instance.id,
            state: instance.state,
            detail:
              `"${instance.subject}" is ${instance.state} but the item no longer ` +
              `exists. The owning module should have called abandon().`,
          });
          continue;
        }

        if (answer.inStep === false) {
          report.findings.push({
            kind: 'drifted',
            companyId,
            entityType,
            entityId: answer.entityId,
            instanceId: instance.id,
            state: instance.state,
            detail:
              `"${instance.subject}" is ${instance.state} here, and the owning ` +
              `module's own status disagrees. The spine is authoritative ` +
              `(research.md §8); the module's status needs replaying.`,
          });
        }
      }
    }

    report.unreconciledTypes = [...unreconciled].sort();

    if (report.findings.length || report.unreconciledTypes.length) {
      this.logger.warn(
        `Approval reconciliation: ${report.scanned} live approvals scanned, ` +
          `${report.findings.length} finding(s)` +
          (report.unreconciledTypes.length
            ? `, no reconciler for: ${report.unreconciledTypes.join(', ')}`
            : '') +
          '.',
      );
    } else {
      this.logger.log(
        `Approval reconciliation: ${report.scanned} live approvals, nothing adrift.`,
      );
    }

    return report;
  }
}
