import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Employee,
  EmploymentType,
  ExitReason,
  Gender,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import type { RlsContext } from '../../common/prisma/rls-context';
import { rupeesFirstInWords } from '../../common/rupees-in-words';
import { LetterRecordSources } from '../../letters/letter-record-sources';
import {
  computePayrollLine,
  round2,
} from '../../payroll/engine/payroll-computation';
import { FnfService } from '../../payroll/offboarding/fnf.service';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { SitesService } from '../../projects/sites/sites.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { employeeNameOf } from '../employee-name';
import { PiiCipherService } from './pii-cipher.service';

/** The salary heads a letter states, monthly. `*Annual` is twelve times each. */
const SALARY_HEADS = [
  'basic',
  'hra',
  'conveyance',
  'siteAllowance',
  'specialAllowance',
  'gross',
  'pfEmployer',
  'esicEmployer',
  'ctc',
  'netTakeHome',
] as const;

const EXIT_REASON_LABEL: Record<ExitReason, string> = {
  resignation: 'Resignation',
  termination: 'Termination',
  contract_end: 'End of contract',
};

const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  full_time: 'Full time',
  contract: 'Contract',
  daily_wage: 'Daily wage',
};

/** A money figure as a letter prints it: `Prisma.Decimal`, which `stringify` formats en-IN. */
const money = (n: number) => new Prisma.Decimal(round2(n));
const num = (d: Prisma.Decimal | null | undefined) => (d ? d.toNumber() : 0);

/**
 * The `employee` record a letter's fields are read from (2026-10-13).
 *
 * Registered into `LetterRecordSources` on init, which is how `src/letters/` reads an
 * employee without importing `hr` — see that registry for why the dependency points this
 * way. This file is `hr` answering for its own tables (the employee, the salary revision,
 * the location assignment, the exit) and asking every other module through its service:
 * names of designations through `settings`, sites and projects through `projects`, the
 * F&F figures through `payroll`'s `FnfService`. The resignation is `recruitment`'s, and
 * `recruitment` contributes it to the same record from its own side, because it already
 * imports `hr` and asking it from here would close a cycle.
 *
 * ## The shape
 *
 * Exactly the keys in the HR documents contract, flat or one level nested
 * (`revision.ctc`), because a field's `sourcePath` is a dot path and nothing more. A
 * section with nothing behind it — no revision, no transfer, no exit — is **absent**, so
 * its fields pre-fill blank and HR types them, rather than printing a zero that reads as
 * a fact.
 *
 * ## What is deliberately not here
 *
 * Aadhaar, PAN and the bank account number. `FORBIDDEN_FIELD_PATH_FRAGMENTS` would refuse
 * a field reading them anyway; not putting them in the record means there is nothing to
 * refuse. The F&F sheet's bank line carries only the last four digits, which is what a
 * settlement statement prints and all it needs.
 */
@Injectable()
export class EmployeeLetterSource implements OnModuleInit {
  private readonly logger = new Logger(EmployeeLetterSource.name);
  private readonly hrPayroll: HrPayrollConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: LetterRecordSources,
    private readonly referenceData: ReferenceDataService,
    private readonly companies: CompaniesService,
    private readonly sites: SitesService,
    private readonly projects: ProjectsService,
    private readonly pii: PiiCipherService,
    // `forwardRef` because `hr` and `payroll` import each other (see hr.module.ts); the
    // class may not be defined yet when this file is first evaluated.
    @Inject(forwardRef(() => FnfService))
    private readonly fnf: FnfService,
    configService: ConfigService,
  ) {
    this.hrPayroll = configService.get<HrPayrollConfig>('hrPayroll');
  }

  onModuleInit(): void {
    this.sources.register('employee', (caller, id) => this.record(caller, id));
  }

  /** The record, or null when the caller cannot see an employee with this id. */
  async record(
    caller: AuthenticatedUser,
    employeeId: string,
  ): Promise<Record<string, unknown> | null> {
    const ctx = rlsContextFor(caller);
    const rows = await withRlsContext(this.prisma, ctx, async (tx) => {
      const employee = await tx.employee.findFirst({
        where: { id: employeeId },
      });
      if (!employee) return null;
      const manager = employee.reportingToEmployeeId
        ? await tx.employee.findFirst({
            where: { id: employee.reportingToEmployeeId },
            select: {
              id: true,
              employeeCode: true,
              firstName: true,
              lastName: true,
              mobile: true,
            },
          })
        : null;
      const revision = await tx.salaryRevision.findFirst({
        where: { employeeId },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      });
      // The latest two: the transfer the letter is about, and where they were before it.
      const assignments = await tx.employeeLocationAssignment.findMany({
        where: { employeeId },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 2,
      });
      const exit = await tx.exitRecord.findFirst({
        where: { employeeId },
        orderBy: { createdAt: 'desc' },
      });
      return { employee, manager, revision, assignments, exit };
    });
    if (!rows) return null;
    const { employee, manager, revision, assignments, exit } = rows;

    const placeOf = this.placeResolver(ctx);
    const [designation, department, posting, salary] = await Promise.all([
      this.referenceName(caller, 'designation', employee.designationId),
      this.referenceName(caller, 'department', employee.departmentId),
      placeOf(employee.siteId),
      this.salaryFigures(employee),
    ]);

    const record: Record<string, unknown> = {
      fullName: employeeNameOf(employee) ?? '',
      salutation: salutationOf(employee.title, employee.gender),
      // The title says it where the gender was never recorded (2026-10-15): "Mr." on file and
      // "S/o / D/o", "them", "their" on the letter was the record contradicting itself.
      relation: relationOf(genderOf(employee.title, employee.gender)),
      fatherName: employee.fatherName,
      employeeCode: employee.employeeCode,
      email: employee.email,
      phone: employee.mobile,
      address:
        joinAddress(
          employee.permanentAddress,
          employee.permanentCity,
          employee.permanentState,
          employee.permanentPinCode,
        ) ||
        joinAddress(
          employee.presentAddress,
          employee.presentCity,
          employee.presentState,
          employee.presentPinCode,
        ),
      designation,
      department,
      siteName: posting.siteName,
      projectName: posting.projectName,
      placeOfPosting: posting.projectName || posting.siteName,
      dateOfJoining: employee.dateOfJoining,
      reportingManager: manager ? employeeNameOf(manager) ?? '' : '',
      reportingManagerMobile: manager?.mobile ?? '',
      ...pronounsOf(genderOf(employee.title, employee.gender)),
      employmentTypeBoxes: employmentTypeBoxes(employee.employmentType),
      ...salary,
    };

    if (revision) {
      // CTC the way the appointment letter states it — gross plus the employer's PF and
      // ESI — so an increment letter's "revised CTC" compares like with like.
      const ctcFor = async (heads: Partial<Employee>) => {
        const figures = await this.salaryFigures({ ...employee, ...heads });
        return num(figures.ctc as Prisma.Decimal);
      };
      const [ctc, previousCtc] = await Promise.all([
        ctcFor({
          basic: revision.basic,
          hra: revision.hra,
          conveyanceAllowance: revision.conveyance,
          siteAllowance: revision.siteAllowance,
          specialAllowance: revision.specialAllowance,
        }),
        ctcFor({
          basic: revision.previousBasic,
          hra: revision.previousHra,
          conveyanceAllowance: revision.previousConveyance,
          siteAllowance: revision.previousSiteAllowance,
          specialAllowance: revision.previousSpecialAllowance,
        }),
      ]);
      record.revision = {
        effectiveFrom: revision.effectiveFrom,
        ctc: money(ctc),
        ctcInWords: rupeesFirstInWords(round2(ctc)),
        previousCtc: money(previousCtc),
      };
    }

    const [latest, before] = assignments;
    if (latest) {
      const to = await placeOf(latest.siteId);
      const from = await placeOf(before ? before.siteId : employee.siteId);
      record.transfer = {
        toSite: latest.isMobile && !latest.siteId ? 'Mobile' : to.siteName,
        toProject: to.projectName,
        effectiveFrom: latest.effectiveFrom,
        fromProject: from.projectName || from.siteName,
      };
    }

    if (exit) {
      record.exit = {
        lastWorkingDay: exit.lastWorkingDay,
        reason: EXIT_REASON_LABEL[exit.reason] ?? exit.reason,
      };
      const fnf = await this.fnfFigures(caller, employee);
      if (fnf) record.fnf = fnf;
    }

    return record;
  }

  /**
   * The salary heads, monthly and annual, with the employer's PF and ESI.
   *
   * The employer contributions come from `computePayrollLine` — the function payroll pays
   * with — run over a full month with no absence and no overtime. A letter computing them
   * its own way would state a CTC the first payslip contradicts.
   */
  private async salaryFigures(
    employee: Employee,
  ): Promise<Record<string, unknown>> {
    const basic = num(employee.basic);
    const hra = num(employee.hra);
    const conveyance = num(employee.conveyanceAllowance);
    const siteAllowance = num(employee.siteAllowance);
    const specialAllowance = num(employee.specialAllowance);
    const gross = round2(
      basic + hra + conveyance + siteAllowance + specialAllowance,
    );

    let pfEmployer = 0;
    let esicEmployer = 0;
    let netTakeHome = gross;
    try {
      const rates = await this.companies.getPayrollRates(employee.companyId);
      const line = computePayrollLine(
        {
          employeeId: employee.id,
          projectId: null,
          basic,
          hra,
          conveyanceAllowance: conveyance,
          siteAllowance,
          specialAllowance,
          pfApplicable: employee.pfApplicable,
          pfUpperLimit: employee.pfUpperLimit,
          esicApplicable: employee.esicApplicable,
          esicUpperLimit: employee.esicUpperLimit,
          hoursPerDay: num(employee.hoursPerDay) || 8,
          loanEmiDeduction: 0,
          tds: 0,
        },
        { monthDays: 30, payableDays: 30, lopDays: 0, otHours: 0 },
        {
          pfEmployerRatePercent: rates.pfEmployerRate,
          esicEmployerRatePercent: rates.esicEmployerRate,
          gratuityRatePercent: rates.gratuityRate,
          bonusRatePercent: rates.bonusRate,
          otMultiplier: rates.otMultiplier,
        },
        this.hrPayroll.statutory,
      );
      // The whole employer PF contribution — the pension share is part of it, and is
      // what the company pays on the employee's behalf.
      pfEmployer = round2(line.employerPf + line.employerEps);
      esicEmployer = line.employerEsic;
      // What reaches the bank after the employee's own PF, ESI and professional tax — the
      // annexure's "Net Take-Home" (2026-10-15), from the same computation payroll pays with.
      netTakeHome = line.netPay;
    } catch (error) {
      this.logger.warn(
        `Employer PF/ESI for ${
          employee.id
        } could not be computed; stated as 0: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const ctc = round2(gross + pfEmployer + esicEmployer);

    const monthly: Record<(typeof SALARY_HEADS)[number], number> = {
      basic,
      hra,
      conveyance,
      siteAllowance,
      specialAllowance,
      gross,
      pfEmployer,
      esicEmployer,
      ctc,
      netTakeHome,
    };
    const out: Record<string, unknown> = {};
    for (const head of SALARY_HEADS) {
      out[head] = money(monthly[head]);
      out[`${head}Annual`] = money(monthly[head] * 12);
    }
    out.ctcInWords = rupeesFirstInWords(ctc);
    // The client's Annexure I (2026-10-15) has rows for a Dearness Allowance, a Medical
    // Allowance and a Meal Voucher. The salary structure holds none of them, so payroll pays nil
    // under each — and nil is what the annexure states, rather than a figure no payslip shows.
    for (const head of [
      'dearnessAllowance',
      'medicalAllowance',
      'mealVoucher',
    ]) {
      out[head] = money(0);
      out[`${head}Annual`] = money(0);
    }
    // …and it has no Site Allowance row, which this system pays. The row is printed only for
    // somebody who has one (`{{?…}}` in the body drops the line when this is blank), so the
    // annexure is the client's own for everybody else and still adds up for those who do.
    out.siteAllowanceIfAny = siteAllowance ? money(siteAllowance) : '';
    out.siteAllowanceIfAnyAnnual = siteAllowance
      ? money(siteAllowance * 12)
      : '';
    out.ctcAnnualLakh = `${((ctc * 12) / 100_000).toFixed(2)} Lakh`;
    return out;
  }

  /**
   * The F&F sheet's figures, mapped from what `FnfService.compute` actually produces.
   *
   * The sheet has lines the computation does not: reimbursements, bonus, gratuity, notice
   * recovery, "other payable". They are **omitted**, not zeroed — a settlement sheet
   * showing "Gratuity: 0" asserts nothing is owed, which may be untrue; a blank is HR's
   * to fill. Notice days come from `recruitment`'s resignation contribution. Outstanding
   * salary advances are what this system recovers beyond loans and statutory deductions,
   * so they are the sheet's "other deductions".
   *
   * Null when the computation refuses (for instance a clearance item still open), so the
   * rest of the letter still pre-fills.
   */
  private async fnfFigures(
    caller: AuthenticatedUser,
    employee: Employee,
  ): Promise<Record<string, unknown> | null> {
    const hrCaller: Caller = {
      userId: caller.id,
      companyId: caller.companyId,
      ipAddress: '',
      rls: rlsContextFor(caller),
      roleIds: caller.roleIds ?? [],
    };
    try {
      const f = await this.fnf.compute(hrCaller, employee.id);
      const totalPayable = round2(f.pendingSalary + f.leaveEncashment.amount);
      const totalDeductions = round2(
        f.statutoryDeductions + f.loanRecovery + f.advanceRecovery,
      );
      const [year, month] = f.period.split('-').map(Number);
      return {
        // `compute` pro-rates to the last working day's date in its month.
        salaryDays: Number(f.lastWorkingDay.slice(8, 10)),
        salaryPayable: money(f.pendingSalary),
        leaveEncashmentDays: f.leaveEncashment.balanceDays,
        leaveEncashment: money(f.leaveEncashment.amount),
        totalPayable: money(totalPayable),
        statutoryDeductions: money(f.statutoryDeductions),
        loanRecovery: money(f.loanRecovery),
        otherDeductions: money(f.advanceRecovery),
        totalDeductions: money(totalDeductions),
        net: money(f.netPayable),
        netInWords: rupeesFirstInWords(f.netPayable),
        payrollPeriod: new Date(
          Date.UTC(year, month - 1, 1),
        ).toLocaleDateString('en-GB', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        bankLast4: this.bankLast4(employee.bankAccountNumberEncrypted),
        uan: employee.uan ?? '',
        employmentType: employee.employmentType
          ? EMPLOYMENT_TYPE_LABEL[employee.employmentType]
          : '',
      };
    } catch (error) {
      this.logger.warn(
        `F&F figures for ${employee.id} are unavailable; the sheet pre-fills without ` +
          `them: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * The last four digits of the salary account — never the number.
   *
   * Decrypted here because the ciphertext's own last four characters are meaningless; the
   * plaintext does not leave this method.
   */
  private bankLast4(envelope: string | null): string {
    if (!envelope) return '';
    try {
      const plain = this.pii.decrypt(envelope);
      return plain ? plain.slice(-4) : '';
    } catch {
      return '';
    }
  }

  /** A designation or department name, through settings' service. `''` when unset. */
  private async referenceName(
    caller: AuthenticatedUser,
    resource: 'designation' | 'department',
    id: string | null,
  ): Promise<string> {
    if (!id) return '';
    const rows = await this.referenceData.findAll(resource, caller);
    const match = rows.find((row) => row.id === id);
    return match ? String(match.name ?? '') : '';
  }

  /**
   * Resolves a site id to its name and its project's name, through `projects`.
   *
   * Memoised per record: a transfer letter asks about the same two or three sites more
   * than once, and each is a transaction.
   */
  private placeResolver(ctx: RlsContext) {
    const cache = new Map<
      string,
      Promise<{ siteName: string; projectName: string }>
    >();
    return (siteId: string | null) => {
      if (!siteId) return Promise.resolve({ siteName: '', projectName: '' });
      let hit = cache.get(siteId);
      if (!hit) {
        hit = (async () => {
          try {
            const site = await this.sites.getSiteById(ctx, siteId);
            const project = site.projectId
              ? await this.projects.getProjectIdentityById(site.projectId, ctx)
              : null;
            return { siteName: site.name, projectName: project?.name ?? '' };
          } catch {
            return { siteName: '', projectName: '' };
          }
        })();
        cache.set(siteId, hit);
      }
      return hit;
    };
  }
}

/** `title` as recorded, else from gender. `''` when neither says. */
export function salutationOf(
  title: string | null,
  gender: Gender | null,
): string {
  const t = title?.trim();
  if (t) return /\.$/.test(t) ? t : `${t}.`;
  if (gender === Gender.male) return 'Mr.';
  if (gender === Gender.female) return 'Ms.';
  return '';
}

/**
 * The gender as recorded, else as the title implies — "Mr." male, "Ms." / "Mrs." / "Miss" female
 * — else null, which every form derived from it treats as unknown.
 */
export function genderOf(
  title: string | null,
  gender: Gender | null,
): Gender | null {
  if (gender) return gender;
  const t = (title ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (t === 'mr' || t === 'shri' || t === 'sri') return Gender.male;
  if (['ms', 'mrs', 'miss', 'smt', 'kumari'].includes(t)) return Gender.female;
  return null;
}

/**
 * "S/o" or "D/o", as the client's letters write the line naming a parent (2026-10-15). Both when
 * the record does not say, rather than a guess; HR can overwrite it — with "W/o" where the name
 * held is a spouse's.
 */
export function relationOf(gender: Gender | null): string {
  if (gender === Gender.male) return 'S/o';
  if (gender === Gender.female) return 'D/o';
  return 'S/o / D/o';
}

/** Third-person pronouns from gender; they/them/their when the record does not say. */
export function pronounsOf(gender: Gender | null): {
  pronounSubject: string;
  pronounObject: string;
  pronounPossessive: string;
} {
  if (gender === Gender.male) {
    return {
      pronounSubject: 'he',
      pronounObject: 'him',
      pronounPossessive: 'his',
    };
  }
  if (gender === Gender.female) {
    return {
      pronounSubject: 'she',
      pronounObject: 'her',
      pronounPossessive: 'her',
    };
  }
  return {
    pronounSubject: 'they',
    pronounObject: 'them',
    pronounPossessive: 'their',
  };
}

/**
 * The F&F sheet's "☐ Permanent ☐ Fixed-term ☐ Other", with the employee's own ticked
 * (2026-10-15). In "[ ]" boxes because the PDF font has no ☐. All three left open when the record
 * does not say, which is the form as printed.
 */
export function employmentTypeBoxes(type: EmploymentType | null): string {
  const ticked =
    type === EmploymentType.full_time
      ? 'Permanent'
      : type === EmploymentType.contract
      ? 'Fixed-term'
      : type === EmploymentType.daily_wage
      ? 'Other'
      : null;
  return ['Permanent', 'Fixed-term', 'Other']
    .map((label) => `[${label === ticked ? 'X' : ' '}] ${label}`)
    .join('  ');
}

/** "addr, city, state - PIN", skipping whatever is missing. */
export function joinAddress(
  line: string | null,
  city: string | null,
  state: string | null,
  pin: string | null,
): string {
  const place = [line, city, state]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
  const p = pin?.trim();
  if (!p) return place;
  return place ? `${place} - ${p}` : p;
}
