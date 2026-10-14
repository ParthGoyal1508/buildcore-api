import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { LetterKindFieldsService } from '../settings/letter-kinds/letter-kind-fields.service';
import { LetterRecordSources } from './letter-record-sources';
import { LettersService } from './letters.service';

const COMPANY = 'co-1';

type Kind = {
  id: string;
  key: string;
  label: string;
  companyId: string | null;
  requiresSignature: boolean;
  requiresApproval: boolean;
  approvalActionType: string | null;
  isActive: boolean;
};

const kind = (over: Partial<Kind> = {}): Kind => ({
  id: 'k-1',
  key: 'experience',
  label: 'Experience letter',
  companyId: null,
  requiresSignature: false,
  requiresApproval: false,
  approvalActionType: null,
  isActive: true,
  ...over,
});

const WORK_ORDER = kind({
  id: 'k-wo',
  key: 'letter_work_order',
  label: 'Work order',
  requiresApproval: true,
  approvalActionType: 'letter_work_order',
});

type Field = {
  token: string;
  label: string;
  sourceType: 'employee' | 'candidate' | 'company' | 'manual';
  sourcePath: string | null;
  isRequired: boolean;
};

function harness(
  opts: {
    kind?: Kind;
    letter?: Record<string, unknown>;
    /** What the kind declares. None by default, which is every kind before 2026-10-13. */
    fields?: Field[];
    /** The employee record `hr` would register. */
    employee?: Record<string, unknown> | null;
  } = {},
) {
  const k = opts.kind ?? kind();
  const letterRow = {
    id: 'l-1',
    companyId: COMPANY,
    letterKindId: k.id,
    letterKind: k,
    employeeId: null,
    candidateId: null,
    subjectType: 'vendor',
    subjectId: 'v-1',
    templateId: 'tpl-1',
    signatoryId: null,
    appliedSignatureRef: null,
    countersignedRef: null,
    countersignedAt: null,
    renderedRef: '',
    referenceNo: null,
    version: 1,
    isSuperseded: false,
    issuedAt: null,
    issuedBy: 'u-1',
    createdAt: new Date(),
    ...opts.letter,
  };

  const tx = {
    issuedLetter: {
      create: jest.fn(async () => letterRow),
      findFirst: jest.fn(async () => letterRow),
      // Read when a reference is allocated at issue (2026-10-11). Empty, so these
      // letters take 0001 — the series itself is tested in `letter-reference.spec.ts`,
      // where it can be asked about four hundred prior letters without a mock per row.
      findMany: jest.fn(async () => []),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        ...letterRow,
        ...args.data,
      })),
    },
    letterTemplate: {
      findFirst: jest.fn(async () => ({
        id: 'tpl-1',
        companyId: COMPANY,
        bodyTemplate: 'Dear {{vendorName}}, work order for {{amount}}.',
        // Null: the template defers to the company's letterhead, which is the case
        // every company but one will be in.
        letterheadAssetId: null,
      })),
    },
    // Read at render for the company's letterhead (2026-10-11). Null here, so these
    // tests render on plain paper and assert nothing about the artwork — the geometry
    // and the image itself belong to `letter-pdf.renderer.spec.ts`.
    company: {
      findUnique: jest.fn(async () => ({
        letterheadRef: null,
        shortCode: 'TEST',
      })),
    },
    $executeRaw: jest.fn(),
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const storage: any = {
    put: jest.fn(async () => 'letter/co-1/ref-1'),
    get: jest.fn(async () => Buffer.from('png')),
  };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  const kinds: any = { requireByKey: jest.fn(async () => k) };
  const templates: any = {
    getActive: jest.fn(async () => ({
      id: 'tpl-1',
      bodyTemplate: 'Dear {{vendorName}}, work order for {{amount}}.',
    })),
  };
  const documentTypes: any = {
    listForCompany: jest.fn(async () => [
      { code: 'AADHAAR', isRestricted: true },
    ]),
  };
  const signatories: any = {
    requireById: jest.fn(async () => ({
      id: 's-1',
      name: 'Sunil Agarwal',
      title: 'Director',
      signatureRef: 'signature/co-1/v1',
    })),
  };
  const approvals: any = {
    submit: jest.fn().mockResolvedValue(undefined),
    assertMayTakeEffect: jest.fn().mockResolvedValue(undefined),
  };
  // The real `resolve()` — it is the rule under test — with only the read of the
  // declarations stubbed.
  const fields = new LetterKindFieldsService(prisma, kinds);
  jest.spyOn(fields, 'fieldsFor').mockResolvedValue((opts.fields ?? []) as any);
  const records = new LetterRecordSources();
  const employeeResolver = jest.fn(async () => opts.employee ?? null);
  records.register('employee', employeeResolver);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const service = new LettersService(
    prisma,
    storage,
    audit,
    kinds,
    templates,
    documentTypes,
    signatories,
    approvals,
    fields,
    records,
  );
  // What the body was rendered with — the observable half of pre-fill.
  const render = jest.spyOn(service as any, 'render'); // eslint-disable-line @typescript-eslint/no-explicit-any
  const renderedWith = () =>
    render.mock.calls[render.mock.calls.length - 1]?.[3] as Record<
      string,
      string
    >;
  return {
    service,
    approvals,
    storage,
    tx,
    signatories,
    kinds,
    employeeResolver,
    renderedWith,
  };
}

const callerWith = (...permissions: Permission[]) =>
  ({
    id: 'u-1',
    companyId: COMPANY,
    permissions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

const financeCaller = callerWith(Permission.PROJECT_FINANCIALS);
const hrCaller = callerWith(Permission.EMPLOYEES);

const composeWorkOrder = {
  letterKindKey: 'letter_work_order',
  subjectType: 'vendor',
  subjectId: 'v-1',
  variables: { vendorName: 'Shree', amount: '4,50,000' },
};

describe('LettersService — the 016 gate (T041, T045, FR-015a)', () => {
  it('raises the chain for a gated kind and stops, without rendering', async () => {
    const { service, approvals, storage } = harness({ kind: WORK_ORDER });

    const view = await service.compose(financeCaller, composeWorkOrder);

    expect(approvals.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'letter_work_order',
        entityType: 'letter_work_order',
        entityId: 'l-1',
      }),
    );
    // Composed, not issued — and crucially nothing was rendered. A draft PDF is a file
    // indistinguishable from the real thing, sitting in storage with no approval behind it.
    expect(view.status).toBe('composed');
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('asks 016 whether the letter may take effect before issuing it', async () => {
    const { service, approvals } = harness({ kind: WORK_ORDER });

    await service.issue(financeCaller, 'l-1', { vendorName: 'Shree' });

    expect(approvals.assertMayTakeEffect).toHaveBeenCalledWith({
      actionType: 'letter_work_order',
      entityType: 'letter_work_order',
      entityId: 'l-1',
      companyId: COMPANY,
    });
  });

  it('does NOT ask for an ungated kind', async () => {
    const { service, approvals } = harness({ kind: kind() });

    await service.issue(hrCaller, 'l-1', {});

    // FR-022's lesson from 016: refusing where no chain was ever configured would break
    // every ungated letter at once.
    expect(approvals.assertMayTakeEffect).not.toHaveBeenCalled();
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  it('propagates 016’s refusal rather than translating it', async () => {
    const { service, approvals } = harness({ kind: WORK_ORDER });
    approvals.assertMayTakeEffect.mockRejectedValue(
      new ConflictException({ code: 'APPROVAL_NOT_COMPLETE' }),
    );

    const error = await service
      .issue(financeCaller, 'l-1', {})
      .catch((e: unknown) => e);

    // 016 owns the code. A second constant meaning the same thing would let a client
    // branch on the wrong one and be silently wrong.
    expect((error as { response: { code: string } }).response.code).toBe(
      'APPROVAL_NOT_COMPLETE',
    );
  });

  it('leaves the letter unissued when the chain cannot be raised at all', async () => {
    const { service, approvals } = harness({ kind: WORK_ORDER });
    approvals.submit.mockRejectedValue(new Error('no chain configured'));

    await expect(
      service.compose(financeCaller, composeWorkOrder),
    ).rejects.toThrow();

    // Unissued is the safe state: it cannot take effect without a completed chain.
    expect(approvals.assertMayTakeEffect).not.toHaveBeenCalled();
  });
});

describe('LettersService — per-kind authority (contract Part 2)', () => {
  it('refuses a caller whose permissions do not cover the kind', async () => {
    const { service } = harness({ kind: WORK_ORDER });

    const error = await service
      .compose(hrCaller, composeWorkOrder)
      .catch((e: unknown) => e);

    // Somebody who may issue an experience certificate has no business committing the
    // company to a purchase order.
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as { response: { code: string } }).response.code).toBe(
      'LETTER_KIND_FORBIDDEN',
    );
  });

  it('requires SETTINGS for a kind nobody mapped a permission for', async () => {
    const brandNew = kind({
      id: 'k-new',
      key: 'site_pass',
      companyId: COMPANY,
    });
    const { service } = harness({ kind: brandNew });

    const refused = await service
      .compose(hrCaller, { ...composeWorkOrder, letterKindKey: 'site_pass' })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenException);

    // Fails CLOSED. The open answer would turn FR-011 into a way to route around every
    // permission in the map: define a kind, issue anything.
    const admin = callerWith(Permission.SETTINGS);
    await expect(
      service.compose(admin, {
        ...composeWorkOrder,
        letterKindKey: 'site_pass',
      }),
    ).resolves.toBeDefined();
  });
});

describe('LettersService — addressing (research §2)', () => {
  it('refuses a letter addressed both to a person and to a subject', async () => {
    const { service } = harness({ kind: kind() });

    await expect(
      service.compose(hrCaller, {
        letterKindKey: 'experience',
        employeeId: 'e-1',
        subjectType: 'vendor',
        subjectId: 'v-1',
        variables: {},
      }),
    ).rejects.toThrow(/one answer/);
  });

  it('refuses a letter addressed to nobody', async () => {
    const { service } = harness({ kind: kind() });

    await expect(
      service.compose(hrCaller, { letterKindKey: 'experience', variables: {} }),
    ).rejects.toThrow(/must address/);
  });

  it('refuses half an opaque pair', async () => {
    const { service } = harness({ kind: kind() });

    await expect(
      service.compose(hrCaller, {
        letterKindKey: 'experience',
        subjectType: 'vendor',
        variables: {},
      }),
    ).rejects.toThrow(/meaningless apart|must address/);
  });
});

describe('LettersService — the signature freeze (T054, T056, FR-013)', () => {
  const SIGNED = kind({
    id: 'k-sig',
    key: 'transfer',
    requiresSignature: true,
  });

  it('records BOTH the signatory and the graphic as applied', async () => {
    const { service, tx } = harness({
      kind: SIGNED,
      letter: { signatoryId: 's-1' },
    });

    await service.issue(hrCaller, 'l-1', {});

    // Not just `signatoryId`. Storing only the id means re-rendering uses whatever image
    // the signatory has TODAY — and a signature that silently changes is the one thing a
    // signature may never do.
    expect(tx.issuedLetter.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appliedSignatureRef: 'signature/co-1/v1',
        }),
      }),
    );
  });

  it('renders a letter issued with the OLD graphic, after the signatory replaced it', async () => {
    // The test that catches a signatoryId-only implementation. `download` reads the
    // stored `renderedRef` — the bytes as issued — and never re-renders from the
    // signatory's current graphic.
    const { service, storage } = harness({
      kind: SIGNED,
      letter: {
        renderedRef: 'letter/co-1/as-issued',
        appliedSignatureRef: 'signature/co-1/v1',
        issuedAt: new Date('2026-01-01'),
        signatoryId: 's-1',
      },
    });

    await service.download(hrCaller, 'l-1');

    expect(storage.get).toHaveBeenCalledWith('letter/co-1/as-issued');
    // Nothing re-rendered, so the current graphic was never consulted.
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refuses to compose a signature-bearing kind with no signatory named', async () => {
    const { service } = harness({ kind: SIGNED });

    const error = await service
      .compose(hrCaller, {
        letterKindKey: 'transfer',
        employeeId: 'e-1',
        variables: {},
      })
      .catch((e: unknown) => e);

    expect((error as { response: { code: string } }).response.code).toBe(
      'SIGNATORY_REQUIRED',
    );
  });
});

describe('LettersService — reissue (FR-014)', () => {
  it('supersedes rather than overwriting, keeping the old file', async () => {
    const { service, tx } = harness({
      kind: kind(),
      letter: {
        renderedRef: 'letter/co-1/v1',
        issuedAt: new Date('2026-01-01'),
        employeeId: 'e-1',
        subjectType: null,
        subjectId: null,
        referenceNo: 'PRPL/HR/2026-27/0007',
      },
    });

    await service.reissue(hrCaller, 'l-1', { variables: { name: 'Anil' } });

    // The original is marked superseded, not deleted, and a NEW row carries v2.
    //
    // It also gives up its reference number (2026-10-11): a reissue is the same letter
    // corrected, so version 2 keeps `PRPL/HR/2026-27/0007` rather than taking a new
    // number that would read as a second letter. `@@unique([companyId, referenceNo])`
    // means the original has to release it in the same transaction, which is why this is
    // part of the supersede and not a separate write.
    expect(tx.issuedLetter.update).toHaveBeenCalledWith({
      where: { id: 'l-1' },
      data: { isSuperseded: true, referenceNo: null },
    });
    expect(tx.issuedLetter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 2,
          // The replacement takes the reference the original released. Asserting only
          // `version: 2` passed while the number was printed on the PDF and held by no
          // row at all — the letter was unfindable by the number its recipient quotes.
          referenceNo: 'PRPL/HR/2026-27/0007',
        }),
      }),
    );
  });

  it('refuses to reissue something never issued', async () => {
    const { service } = harness({ kind: kind() });

    const error = await service
      .reissue(hrCaller, 'l-1', { variables: {} })
      .catch((e: unknown) => e);

    expect((error as { response: { code: string } }).response.code).toBe(
      'LETTER_NOT_ISSUED',
    );
  });
});

describe('LettersService — FR-024 on every render, not only at save', () => {
  it('refuses to render a template that references a restricted type', async () => {
    const { service, tx } = harness({ kind: kind() });
    tx.letterTemplate.findFirst = jest.fn(async () => ({
      id: 'tpl-1',
      companyId: COMPANY,
      bodyTemplate: 'Aadhaar: {{document.AADHAAR}}',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;

    const error = await service
      .issue(hrCaller, 'l-1', {})
      .catch((e: unknown) => e);

    // Checked at render as well as at save, because `isRestricted` can be switched on
    // AFTER a template was written — and a rule enforced only at save would let that
    // template keep rendering the thing that just became regulated.
    expect((error as { response: { code: string } }).response.code).toBe(
      'DOCUMENT_TYPE_RESTRICTED',
    );
  });
});

describe('LettersService — pre-filled from the records (2026-10-13)', () => {
  const APPOINTMENT = kind({
    id: 'k-exp',
    key: 'experience',
    label: 'Experience',
  });
  const FIELDS: Field[] = [
    {
      token: 'employeeName',
      label: 'Employee name',
      sourceType: 'employee',
      sourcePath: 'fullName',
      isRequired: true,
    },
    {
      token: 'designation',
      label: 'Designation',
      sourceType: 'employee',
      sourcePath: 'designation',
      isRequired: true,
    },
    {
      token: 'newCtc',
      label: 'Revised CTC',
      sourceType: 'employee',
      sourcePath: 'revision.ctc',
      isRequired: false,
    },
    {
      token: 'dutyStart',
      label: 'Duty starts',
      sourceType: 'manual',
      sourcePath: null,
      isRequired: true,
    },
    {
      token: 'companyName',
      label: 'Company',
      sourceType: 'company',
      sourcePath: 'name',
      isRequired: true,
    },
  ];
  const EMPLOYEE = {
    fullName: 'Mohit Chaudhary',
    designation: 'Project Manager',
    revision: { ctc: 52000 },
  };
  const COMPANY_ROW = {
    letterheadRef: null,
    shortCode: 'PRPL',
    name: 'Parth Realcon Pvt Ltd',
    address: null,
    city: null,
    state: null,
    pinCode: null,
  };

  function prefilled(over: Parameters<typeof harness>[0] = {}) {
    const h = harness({
      kind: APPOINTMENT,
      fields: FIELDS,
      employee: EMPLOYEE,
      letter: { employeeId: 'e-1', subjectType: null, subjectId: null },
      ...over,
    });
    h.tx.company.findUnique = jest.fn(async () => COMPANY_ROW) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return h;
  }

  it('opens the form with every declared field and what the records say', async () => {
    const { service, employeeResolver } = prefilled();

    const view = await service.prefill(hrCaller, {
      letterKindKey: 'experience',
      employeeId: 'e-1',
    });

    expect(employeeResolver).toHaveBeenCalledWith(hrCaller, 'e-1');
    expect(view.fields.map((f) => [f.token, f.value])).toEqual([
      ['employeeName', 'Mohit Chaudhary'],
      ['designation', 'Project Manager'],
      ['newCtc', '52000'],
      // Manual: nothing to read, so HR types it.
      ['dutyStart', ''],
      ['companyName', 'Parth Realcon Pvt Ltd'],
    ]);
    expect(view.fields[3]).toEqual(
      expect.objectContaining({ sourceType: 'manual', isRequired: true }),
    );
  });

  it('never refuses the form for a missing value — that is compose’s job', async () => {
    const { service } = prefilled({ employee: null });

    const view = await service.prefill(hrCaller, {
      letterKindKey: 'experience',
      employeeId: 'e-gone',
    });

    expect(
      view.fields.every((f) => f.value === '' || f.token === 'companyName'),
    ).toBe(true);
  });

  it('applies the kind’s own permission to the form, since it carries pay', async () => {
    const { service } = prefilled({ kind: WORK_ORDER });

    await expect(
      service.prefill(hrCaller, { letterKindKey: 'letter_work_order' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('issues from the records, with only the manual field supplied', async () => {
    const { service, renderedWith } = prefilled();

    await service.compose(hrCaller, {
      letterKindKey: 'experience',
      employeeId: 'e-1',
      variables: { dutyStart: '9:30 AM' },
    });

    expect(renderedWith()).toEqual(
      expect.objectContaining({
        employeeName: 'Mohit Chaudhary',
        designation: 'Project Manager',
        dutyStart: '9:30 AM',
        companyName: 'Parth Realcon Pvt Ltd',
      }),
    );
  });

  it('lets HR type over a record value, and falls back to the record on a blank', async () => {
    const { service, renderedWith } = prefilled();

    await service.compose(hrCaller, {
      letterKindKey: 'experience',
      employeeId: 'e-1',
      variables: {
        dutyStart: '9:30 AM',
        designation: 'Senior Project Manager',
        // Cleared in the form: the record stands, rather than a blank being printed.
        employeeName: '',
      },
    });

    expect(renderedWith().designation).toBe('Senior Project Manager');
    expect(renderedWith().employeeName).toBe('Mohit Chaudhary');
  });

  it('refuses a required value nobody holds, before writing a row', async () => {
    const { service, tx } = prefilled();

    const error = await service
      .compose(hrCaller, { letterKindKey: 'experience', employeeId: 'e-1' })
      .catch((e: unknown) => e);

    expect(
      (error as { response: { code: string; fields: string[] } }).response,
    ).toEqual(
      expect.objectContaining({
        code: 'LETTER_REQUIRED_FIELD_UNRESOLVED',
        fields: ['dutyStart'],
      }),
    );
    // A composed row left behind by a refused compose is a letter nobody asked for.
    expect(tx.issuedLetter.create).not.toHaveBeenCalled();
  });

  it('re-resolves a letter composed earlier from its own employee at issue', async () => {
    // Composed before pre-fill, or held in an approval chain: `issue` is called with only
    // what HR wants to add, and the rest is read again from the letter's recipient.
    const { service, employeeResolver, renderedWith } = prefilled();

    await service.issue(hrCaller, 'l-1', { dutyStart: '10:00 AM' });

    expect(employeeResolver).toHaveBeenCalledWith(hrCaller, 'e-1');
    expect(renderedWith().employeeName).toBe('Mohit Chaudhary');
  });

  it('re-resolves on reissue too, so a correction need not retype the letter', async () => {
    const { service, renderedWith } = prefilled({
      letter: {
        employeeId: 'e-1',
        subjectType: null,
        subjectId: null,
        renderedRef: 'letter/co-1/v1',
        issuedAt: new Date('2026-01-01'),
      },
    });

    await service.reissue(hrCaller, 'l-1', {
      variables: { dutyStart: '9:00 AM' },
    });

    expect(renderedWith()).toEqual(
      expect.objectContaining({
        employeeName: 'Mohit Chaudhary',
        dutyStart: '9:00 AM',
      }),
    );
  });

  it('renders a kind with no declared fields from `variables`, as before', async () => {
    const { service, renderedWith } = harness({ kind: kind() });

    await service.issue(hrCaller, 'l-1', { vendorName: 'Shree' });

    expect(renderedWith()).toEqual({ vendorName: 'Shree' });
  });
});

describe('LetterRecordSources', () => {
  it('merges contributions one level deep, so two modules can fill one section', async () => {
    const sources = new LetterRecordSources();
    sources.register('employee', async () => ({
      fullName: 'A',
      fnf: { net: 100 },
    }));
    sources.register('employee', async () => ({
      resignation: { date: '2026-09-01' },
      fnf: { noticeRequiredDays: 30 },
    }));

    await expect(sources.resolve(hrCaller, 'employee', 'e-1')).resolves.toEqual(
      {
        fullName: 'A',
        fnf: { net: 100, noticeRequiredDays: 30 },
        resignation: { date: '2026-09-01' },
      },
    );
  });

  it('skips a contributor that fails, and answers null when nobody knows the id', async () => {
    const sources = new LetterRecordSources();
    sources.register('employee', async () => {
      throw new Error('boom');
    });
    sources.register('employee', async () => null);

    await expect(
      sources.resolve(hrCaller, 'employee', 'e-1'),
    ).resolves.toBeNull();
    await expect(
      sources.resolve(hrCaller, 'candidate', 'c-1'),
    ).resolves.toBeNull();
  });
});
