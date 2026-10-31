import { EngagementType, LabourGender, Prisma } from '@prisma/client';

import { WORKER_EDITABLE_FIELDS } from '../constants/labour.constants';

export type WorkerEditableField = (typeof WORKER_EDITABLE_FIELDS)[number];

/** The stored values an edit compares against. */
export interface WorkerEditableState {
  fullName: string;
  gender: LabourGender | null;
  fatherName: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  skillCategoryId: string | null;
  engagementType: EngagementType;
  contractorId: string | null;
  aadhaarNumber: string | null;
  bankAccount: string | null;
  rateOverride: Prisma.Decimal | null;
}

/** An edit as the API receives it: omitted = unchanged, null = cleared. */
export interface WorkerEditInput {
  fullName?: string;
  gender?: LabourGender;
  fatherName?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  skillCategoryId?: string | null;
  engagementType?: EngagementType;
  contractorId?: string | null;
  aadhaarNumber?: string | null;
  bankAccount?: string | null;
  rateOverride?: number | null;
}

/** The values the worker will hold after the edit, normalised the way registration stores them. */
export interface WorkerEditPlan {
  next: {
    fullName: string;
    gender: LabourGender | null;
    fatherName: string | null;
    phone: string | null;
    dateOfBirth: Date | null;
    skillCategoryId: string | null;
    engagementType: EngagementType;
    contractorId: string | null;
    aadhaarNumber: string | null;
    bankAccount: string | null;
    rateOverride: number | null;
  };
  /** Field names whose value changes — what the audit log records (never the values). */
  changed: WorkerEditableField[];
}

/** Blank text is stored as null, as registration does. */
const text = (value: string | null | undefined): string | null =>
  value?.trim() || null;

const dateOnly = (value: string): Date =>
  new Date(`${value.slice(0, 10)}T00:00:00.000Z`);

/**
 * Works out a worker edit (052): the resulting values and which fields change. Pure, so the rules —
 * omitted vs cleared, blank text as null, a direct worker carrying no contractor — are tested
 * without a database. Validation that needs one (contractor active, Aadhaar unique, skill exists,
 * permission for the rate) is the service's.
 */
export function planWorkerEdit(
  current: WorkerEditableState,
  input: WorkerEditInput,
): WorkerEditPlan {
  const pick = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;

  const engagementType = pick(input.engagementType, current.engagementType);
  const contractorId =
    engagementType === EngagementType.contractor
      ? input.contractorId === undefined
        ? current.contractorId
        : text(input.contractorId)
      : null;

  const next: WorkerEditPlan['next'] = {
    fullName:
      input.fullName === undefined ? current.fullName : input.fullName.trim(),
    gender: pick(input.gender, current.gender),
    fatherName:
      input.fatherName === undefined
        ? current.fatherName
        : text(input.fatherName),
    phone: input.phone === undefined ? current.phone : text(input.phone),
    dateOfBirth:
      input.dateOfBirth === undefined
        ? current.dateOfBirth
        : input.dateOfBirth
        ? dateOnly(input.dateOfBirth)
        : null,
    skillCategoryId:
      input.skillCategoryId === undefined
        ? current.skillCategoryId
        : text(input.skillCategoryId),
    engagementType,
    contractorId,
    aadhaarNumber:
      input.aadhaarNumber === undefined
        ? current.aadhaarNumber
        : text(input.aadhaarNumber),
    bankAccount:
      input.bankAccount === undefined
        ? current.bankAccount
        : text(input.bankAccount),
    rateOverride:
      input.rateOverride === undefined
        ? current.rateOverride
          ? current.rateOverride.toNumber()
          : null
        : input.rateOverride,
  };

  const before: Record<WorkerEditableField, unknown> = {
    ...current,
    dateOfBirth: current.dateOfBirth?.getTime() ?? null,
    rateOverride: current.rateOverride ? current.rateOverride.toNumber() : null,
  };
  const after: Record<WorkerEditableField, unknown> = {
    ...next,
    dateOfBirth: next.dateOfBirth?.getTime() ?? null,
  };
  const changed = WORKER_EDITABLE_FIELDS.filter(
    (field) => before[field] !== after[field],
  );
  return { next, changed };
}
