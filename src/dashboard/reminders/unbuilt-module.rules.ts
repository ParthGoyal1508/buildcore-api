import { ReminderRule } from './reminder-rule.decorator';
import {
  ReminderCandidate,
  ReminderRuleProvider,
  ReminderSeverityLadder,
} from './reminder-rule.types';

/**
 * Placeholder rules for the three modules spec FR-036 names as registrants, none of
 * which is built yet.
 *
 * These exist so FR-031 is a live, observable behaviour rather than a promise: a
 * caller reading the reminders list today gets an explicit "these rule sources exist
 * but their module is pending" alongside an empty result, instead of an empty result
 * that could equally mean "nothing is due". Those are very different things to a
 * user, and the difference is exactly what the placeholder buys.
 *
 * They are the direct analogue of T016's unbuilt-module *widget* placeholders, which
 * live in this feature for the same reason.
 *
 * WHEN THE OWNING MODULE IS BUILT: delete its placeholder here and register the real
 * provider from that module's own `@Module` — that is the whole point of FR-028, and
 * leaving the placeholder in place would double-report the rule as both available
 * and pending.
 */
abstract class PendingModuleRule implements ReminderRuleProvider {
  abstract readonly ruleKey: string;
  abstract readonly sourceModule: string;
  abstract readonly type: string;
  abstract readonly entityType: string;

  /**
   * Declared even though nothing reads them while the rule is unavailable, so the
   * registry's synced catalogue row carries the real intended window from day one
   * and the owning module inherits a decision rather than inventing one.
   */
  readonly leadDays: number = 30;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 7 };

  isAvailable(): boolean {
    return false;
  }

  /**
   * Never called — `RemindersService` checks `isAvailable()` first. Present because
   * the interface requires it, and throwing rather than returning `[]` means a
   * future refactor that forgets the availability check fails loudly in a test
   * instead of silently reporting "nothing due" for a whole module.
   */
  evaluate(): Promise<ReminderCandidate[]> {
    return Promise.reject(
      new Error(
        `${this.ruleKey}: evaluate() called on an unavailable rule — ` +
          'check isAvailable() first.',
      ),
    );
  }
}

/** Feature 002's company-documents amendment (FR-036). */
@ReminderRule()
export class CompanyDocumentExpiryRule extends PendingModuleRule {
  readonly ruleKey = 'settings-company-document-expiry';
  readonly sourceModule = 'settings';
  readonly type = 'document_expiry';
  readonly entityType = 'COMPANY_DOCUMENT';
  /** Statutory registrations take weeks to renew, so the warning band is wider. */
  readonly leadDays = 60;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 14 };
}

/** Feature 006's equipment document expiry (FR-036). */
@ReminderRule()
export class EquipmentDocumentExpiryRule extends PendingModuleRule {
  readonly ruleKey = 'machinery-document-expiry';
  readonly sourceModule = 'machinery';
  readonly type = 'document_expiry';
  readonly entityType = 'EQUIPMENT_DOCUMENT';
  readonly leadDays = 60;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 14 };
}

/** Feature 006's service-due reminders (FR-036). */
@ReminderRule()
export class EquipmentServiceDueRule extends PendingModuleRule {
  readonly ruleKey = 'machinery-service-due';
  readonly sourceModule = 'machinery';
  readonly type = 'service_due';
  readonly entityType = 'EQUIPMENT';
  /** A service is scheduled, not applied for — a fortnight's notice is enough. */
  readonly leadDays = 14;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 3 };
}

/** Feature 012's asset document expiry (FR-036). */
@ReminderRule()
export class AssetDocumentExpiryRule extends PendingModuleRule {
  readonly ruleKey = 'project-assets-document-expiry';
  readonly sourceModule = 'project_assets';
  readonly type = 'document_expiry';
  readonly entityType = 'ASSET_DOCUMENT';
  readonly leadDays = 60;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 14 };
}

/** Feature 012's inspection-due reminders (FR-036). */
@ReminderRule()
export class AssetInspectionDueRule extends PendingModuleRule {
  readonly ruleKey = 'project-assets-inspection-due';
  readonly sourceModule = 'project_assets';
  readonly type = 'inspection_due';
  readonly entityType = 'ASSET';
  readonly leadDays = 14;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 3 };
}

/** Feature 012's overdue-return reminders (FR-036). */
@ReminderRule()
export class AssetOverdueReturnRule extends PendingModuleRule {
  readonly ruleKey = 'project-assets-overdue-return';
  readonly sourceModule = 'project_assets';
  readonly type = 'overdue_return';
  readonly entityType = 'ASSET_ASSIGNMENT';
  /**
   * Zero lead: an asset is not "nearly overdue for return", it is either back on its
   * due date or it is not. Every reminder this rule produces will be `overdue`.
   */
  readonly leadDays = 0;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 0 };
}

/** Every placeholder, for the module's provider list. */
export const UNBUILT_MODULE_RULES = [
  CompanyDocumentExpiryRule,
  EquipmentDocumentExpiryRule,
  EquipmentServiceDueRule,
  AssetDocumentExpiryRule,
  AssetInspectionDueRule,
  AssetOverdueReturnRule,
];
