import { AuditEntityType } from '@prisma/client';

import {
  entityTypesForModule,
  moduleForEntityType,
} from './module-bucket-mapping';

describe('module-bucket-mapping', () => {
  it('maps HR and login entity types into the HR bucket', () => {
    expect(moduleForEntityType(AuditEntityType.PUNCH)).toBe('hr');
    expect(moduleForEntityType(AuditEntityType.LEAVE_APPLICATION)).toBe('hr');
    expect(moduleForEntityType(AuditEntityType.LOGIN_SUCCESS)).toBe('hr');
  });

  it('maps settings and machinery entity types into their own buckets', () => {
    expect(moduleForEntityType(AuditEntityType.COMPANY)).toBe('settings');
    expect(moduleForEntityType(AuditEntityType.SHIFT)).toBe('settings');
    expect(moduleForEntityType(AuditEntityType.MAINTENANCE_JOB)).toBe(
      'machinery',
    );
    expect(moduleForEntityType(AuditEntityType.FUEL_ENTRY)).toBe('machinery');
  });

  it('resolves the entity types a module filter selects', () => {
    const settings = entityTypesForModule('settings');
    expect(settings).toContain(AuditEntityType.COMPANY);
    expect(settings).not.toContain(AuditEntityType.PUNCH);
  });

  it('returns null for no module and empty for an unknown one', () => {
    expect(entityTypesForModule(undefined)).toBeNull();
    expect(entityTypesForModule('does-not-exist')).toEqual([]);
  });

  it('places every entity type in exactly one bucket', () => {
    for (const type of Object.values(AuditEntityType)) {
      // REPORT_EXPORT and REMINDER fold into HR; nothing is left unmapped.
      expect(moduleForEntityType(type)).not.toBe('other');
    }
  });
});
