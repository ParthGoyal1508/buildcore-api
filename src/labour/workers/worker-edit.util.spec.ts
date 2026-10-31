import { EngagementType, LabourGender, Prisma } from '@prisma/client';

import { planWorkerEdit, WorkerEditableState } from './worker-edit.util';

const current: WorkerEditableState = {
  fullName: 'Dummy Ramesh',
  gender: LabourGender.male,
  fatherName: 'Dummy Suresh',
  phone: '9876543210',
  dateOfBirth: new Date('1990-05-20T00:00:00.000Z'),
  skillCategoryId: 'skill-1',
  engagementType: EngagementType.contractor,
  contractorId: 'vendor-1',
  aadhaarNumber: '123412341234',
  bankAccount: '000111222333',
  rateOverride: new Prisma.Decimal(650),
};

describe('planWorkerEdit (052)', () => {
  it('changes nothing for an empty edit', () => {
    const plan = planWorkerEdit(current, {});
    expect(plan.changed).toEqual([]);
    expect(plan.next.rateOverride).toBe(650);
    expect(plan.next.contractorId).toBe('vendor-1');
  });

  it('treats an unchanged value as no change', () => {
    const plan = planWorkerEdit(current, {
      fullName: ' Dummy Ramesh ',
      dateOfBirth: '1990-05-20',
      rateOverride: 650,
    });
    expect(plan.changed).toEqual([]);
  });

  it('clears optional fields with null and blank text', () => {
    const plan = planWorkerEdit(current, {
      fatherName: '',
      phone: null,
      dateOfBirth: null,
      aadhaarNumber: null,
      rateOverride: null,
    });
    expect(plan.next).toMatchObject({
      fatherName: null,
      phone: null,
      dateOfBirth: null,
      aadhaarNumber: null,
      rateOverride: null,
    });
    expect(plan.changed).toEqual([
      'fatherName',
      'phone',
      'dateOfBirth',
      'aadhaarNumber',
      'rateOverride',
    ]);
  });

  it('drops the contractor when the worker becomes direct, whatever was sent', () => {
    const plan = planWorkerEdit(current, {
      engagementType: EngagementType.direct,
      contractorId: 'vendor-2',
    });
    expect(plan.next.contractorId).toBeNull();
    expect(plan.changed).toEqual(['engagementType', 'contractorId']);
  });

  it('keeps the existing contractor when only other fields change', () => {
    const plan = planWorkerEdit(current, { gender: LabourGender.female });
    expect(plan.next.contractorId).toBe('vendor-1');
    expect(plan.changed).toEqual(['gender']);
  });

  it('takes a new contractor for a direct worker becoming contractor-engaged', () => {
    const plan = planWorkerEdit(
      { ...current, engagementType: EngagementType.direct, contractorId: null },
      { engagementType: EngagementType.contractor, contractorId: 'vendor-9' },
    );
    expect(plan.next.contractorId).toBe('vendor-9');
    expect(plan.changed).toEqual(['engagementType', 'contractorId']);
  });
});
