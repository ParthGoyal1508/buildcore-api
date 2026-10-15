import { BadRequestException, Injectable } from '@nestjs/common';
import {
  EquipmentOwnership,
  EquipmentStatus,
  MeterType,
  PowerSource,
  RegistrationKind,
  RegistrationStatus,
} from '@prisma/client';
import * as ExcelJS from 'exceljs';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  type FormCell,
  type FormFormat,
  type RenderedForm,
  dashDate,
  fileSafe,
  renderFormFile,
} from '../../common/form-document';
import { EquipmentCategoriesService } from '../../settings/machinery-masters/equipment-categories.service';
import { REGISTRATION_PAPERS } from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import type { CreateEquipmentDto, ListEquipmentDto } from './dto/equipment.dto';
import {
  type EquipmentRow,
  EquipmentService,
  type RegistrationPaperView,
} from './equipment.service';

/** What a run of the master-list import did, row by row where it matters. */
export interface EquipmentImportResult {
  categoriesCreated: number;
  categoriesExisting: number;
  equipmentCreated: number;
  /** Rows that described a machine but could not be registered, with the reason. */
  skipped: { row: number; name: string; reason: string }[];
}

const AMBER = 'FFE699';
const RED = 'F4B6B6';

/** Days from today to `date`, by calendar date. */
function daysUntil(date: Date, today: Date): number {
  return Math.round((date.getTime() - today.getTime()) / 86_400_000);
}

/**
 * The vehicle register and the Equipment Master List import (2026-10-15).
 *
 * **The register** is the client's "M/S … — VEHICLE DETAILS (As on …)" sheet: every machine with
 * its make and model, manufacturing year and registration number, then the six papers — RC,
 * insurance, fitness, road tax, permit, pollution — each as an expiry (or N/A, or life time) and
 * whether the scanned copy is on file, then the firm the RC stands in and where the machine is.
 * An expiry inside 30 days is shaded amber and a lapsed one red, as the client shades theirs.
 *
 * **The import** reads the client's "PRPL Construction Equipment & Machinery Master List": a
 * catalogue of 323 machine types under 11 families. Every listed type becomes an equipment
 * category under its family, so the registration form offers the client's own list; and any row
 * that also describes an actual machine — a make, a registration number, an operator — registers
 * that machine as well, coded from its name like any other.
 */
@Injectable()
export class EquipmentRegisterService {
  constructor(
    private readonly equipment: EquipmentService,
    private readonly categories: EquipmentCategoriesService,
    private readonly refs: PlantRefsService,
  ) {}

  // ── The register ───────────────────────────────────────────────────────────

  async register(
    caller: AuthenticatedUser,
    query: Omit<ListEquipmentDto, 'page' | 'pageSize'>,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const companyId = this.refs.targetCompanyOf(caller, query.companyId);
    const [rows, company] = await Promise.all([
      this.equipment.findEvery(caller, { ...query, companyId }),
      this.refs.documentCompany(companyId),
    ]);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const asOn = dashDate(today);

    const paper = (row: EquipmentRow, kind: RegistrationKind) =>
      row.registration.find((item) => item.kind === kind);
    const expiry = (item: RegistrationPaperView | undefined): FormCell => {
      if (!item) return { text: '-', align: 'center' };
      if (item.status === RegistrationStatus.not_applicable) {
        return { text: 'N/A', align: 'center' };
      }
      if (item.status === RegistrationStatus.lifetime) {
        return { text: 'LIFE TIME', align: 'center' };
      }
      if (!item.expiresAt) return { text: 'YES', align: 'center' };
      const days = daysUntil(new Date(item.expiresAt), today);
      return {
        text: dashDate(item.expiresAt),
        align: 'center',
        fill: days < 0 ? RED : days <= 30 ? AMBER : undefined,
      };
    };
    const doc = (item: RegistrationPaperView | undefined): FormCell => ({
      text: item?.hasDocument
        ? 'YES'
        : item?.status === RegistrationStatus.not_applicable
        ? 'N/A'
        : '-',
      align: 'center',
    });
    // The RC column says whether the RC is held, not when it lapses: an RC runs fifteen years.
    const rc = (item: RegistrationPaperView | undefined): FormCell => ({
      text: !item
        ? '-'
        : item.status === RegistrationStatus.not_applicable
        ? 'N/A'
        : 'YES',
      align: 'center',
    });

    const body = rows.map((row, index) => {
      const papers = Object.fromEntries(
        REGISTRATION_PAPERS.map((p) => [
          p.kind,
          paper(row, p.kind as RegistrationKind),
        ]),
      ) as Record<RegistrationKind, RegistrationPaperView | undefined>;
      return [
        String(index + 1),
        { text: row.name, bold: true },
        [row.make, row.model].filter(Boolean).join(' ') || '-',
        row.manufacturingYear ? String(row.manufacturingYear) : '-',
        row.registrationNo ?? row.code,
        rc(papers.rc),
        expiry(papers.insurance),
        doc(papers.insurance),
        expiry(papers.fitness),
        doc(papers.fitness),
        expiry(papers.road_tax),
        doc(papers.road_tax),
        expiry(papers.permit),
        doc(papers.permit),
        expiry(papers.pollution),
        doc(papers.pollution),
        { text: row.registeredOwner ?? company.name, bold: true },
        { text: row.remarks ?? row.siteName ?? '', bold: true },
      ];
    });

    return renderFormFile(
      {
        company,
        title: `M/S ${company.name.toUpperCase()} - VEHICLE DETAILS`,
        caption: `(As on ${asOn})`,
        landscape: true,
        accent: 'plain',
        sheetName: 'Vehicle Details',
        footer: 'Amber: expires within 30 days. Red: expired.',
        blocks: [
          {
            kind: 'table',
            fontSize: 6.5,
            columns: [
              { label: 'S.No', width: 3, align: 'center' },
              { label: 'Vehicle Name', width: 9 },
              { label: 'Make / Model', width: 9 },
              { label: 'Mfg. Year', width: 4.5, align: 'center' },
              { label: 'Vehicle Registration No', width: 8.5 },
              { label: 'RC', width: 3.5, align: 'center' },
              { label: 'Insurance Expiry Date', width: 6.5 },
              { label: 'Insurance Doc', width: 5.5 },
              { label: 'Fitness Expire Date', width: 6.5 },
              { label: 'Fitness Doc', width: 4.5 },
              { label: 'Road Tax', width: 6.5 },
              { label: 'Tax Doc', width: 4 },
              { label: 'Permit', width: 6 },
              { label: 'Permit Doc', width: 4 },
              { label: 'Pollution Expiry Date', width: 6.5 },
              { label: 'Pollution Doc', width: 5.5 },
              { label: 'Firm', width: 9 },
              { label: 'Remark', width: 9 },
            ],
            rows: body.length
              ? body
              : [
                  [
                    {
                      text: 'No machines registered yet.',
                      span: 18,
                      align: 'center',
                    },
                  ],
                ],
          },
        ],
      },
      format,
      fileSafe(`Vehicle Details ${asOn}`),
    );
  }

  // ── The master list import ─────────────────────────────────────────────────

  async importMasterList(
    caller: AuthenticatedUser,
    fileBase64: string,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<EquipmentImportResult> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const rows = await this.readSheet(fileBase64);
    if (rows.length === 0) {
      throw new BadRequestException(
        'No equipment rows found. The sheet needs a header row with "Category" and ' +
          '"Equipment / Machinery Name" columns, as the Equipment Master List has.',
      );
    }

    const { ids, created, existing } = await this.categories.importCatalogue(
      caller,
      companyId,
      rows.map((row) => ({
        group: row.category,
        name: row.name,
        // A road vehicle runs on its odometer; everything else on its hour meter.
        meterType: /vehicle|fleet/i.test(row.category ?? '')
          ? MeterType.km
          : MeterType.hours,
      })),
    );

    const sites = await this.refs.companySites(caller, companyId);
    const siteByName = new Map(
      sites.map((site) => [site.name.trim().toUpperCase(), site.id]),
    );

    const result: EquipmentImportResult = {
      categoriesCreated: created,
      categoriesExisting: existing,
      equipmentCreated: 0,
      skipped: [],
    };
    for (const row of rows.filter((r) => r.describesMachine)) {
      const categoryId = ids.get(row.name.trim().toUpperCase().slice(0, 80));
      if (!categoryId) continue;
      if (row.ownership === EquipmentOwnership.hired) {
        result.skipped.push({
          row: row.line,
          name: row.name,
          reason:
            'Hired: register it from the form, where the hire vendor can be chosen.',
        });
        continue;
      }
      const registration: CreateEquipmentDto['registration'] =
        row.insuranceExpiry
          ? [
              {
                kind: RegistrationKind.insurance,
                status: RegistrationStatus.held,
                expiresAt: row.insuranceExpiry,
              },
            ]
          : undefined;
      try {
        const machine = await this.equipment.create(
          caller,
          {
            name: row.name,
            categoryId,
            ownership: row.ownership,
            powerSource: PowerSource.diesel,
            make: row.make ?? undefined,
            model: row.model ?? undefined,
            registrationNo: row.registrationNo ?? undefined,
            engineNo: row.engineNo ?? undefined,
            chassisNo: row.chassisNo ?? undefined,
            supplierName: row.supplierName ?? undefined,
            operatorName: row.operator ?? undefined,
            remarks: row.remarks ?? row.location ?? undefined,
            manufacturingYear: row.manufacturingYear ?? undefined,
            purchaseDate: row.purchaseDate ?? undefined,
            lastServiceDate: row.lastServiceDate ?? undefined,
            currentReading: row.reading ?? undefined,
            deployedSiteId: row.location
              ? siteByName.get(row.location.trim().toUpperCase())
              : undefined,
            registration,
          },
          ipAddress,
          companyId,
        );
        if (row.status && row.status !== EquipmentStatus.active) {
          await this.equipment.update(
            caller,
            machine.id,
            { status: row.status },
            ipAddress,
          );
        }
        result.equipmentCreated += 1;
      } catch (error) {
        result.skipped.push({
          row: row.line,
          name: row.name,
          reason: error instanceof Error ? error.message : 'Could not register',
        });
      }
    }
    return result;
  }

  /**
   * The sheet's rows, read by header name rather than position, so a client copy with a column
   * added or moved still imports. Reading stops at the "Note:-" box under the list.
   */
  private async readSheet(fileBase64: string) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(
        Buffer.from(fileBase64, 'base64') as unknown as ExcelJS.Buffer,
      );
    } catch {
      throw new BadRequestException(
        'The file is not a readable .xlsx workbook.',
      );
    }

    const text = (value: ExcelJS.CellValue): string | null => {
      if (value === null || value === undefined) return null;
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value === 'object') {
        if ('richText' in value) {
          return (
            value.richText
              .map((part) => part.text)
              .join('')
              .trim() || null
          );
        }
        if ('text' in value) return String(value.text).trim() || null;
        if ('result' in value) return text(value.result as ExcelJS.CellValue);
        return null;
      }
      return String(value).trim() || null;
    };

    for (const sheet of workbook.worksheets) {
      // The header row: the first of the top ten naming both a category and a machine name.
      let headerRow = 0;
      const columns = new Map<string, number>();
      for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
        const labels = new Map<string, number>();
        sheet.getRow(r).eachCell((cell, col) => {
          const label = text(cell.value)?.toLowerCase();
          if (label) labels.set(label, col);
        });
        const find = (...words: string[]) =>
          [...labels].find(([label]) =>
            words.every((w) => label.includes(w)),
          )?.[1];
        const category = find('category');
        const name = find('name') ?? find('equipment');
        if (category && name) {
          headerRow = r;
          const set = (key: string, col: number | undefined) => {
            if (col) columns.set(key, col);
          };
          set('category', category);
          set('name', name);
          set('make', find('make') ?? find('brand'));
          set('model', find('model'));
          set('registration', find('registration') ?? find('vehicle no'));
          set('ownership', find('ownership'));
          set('location', find('location') ?? find('project'));
          set('operator', find('operator'));
          set('purchase', find('purchase') ?? find('hire date'));
          set('reading', find('hours') ?? find('km'));
          set('lastService', find('last service'));
          set('expiry', find('insurance') ?? find('expiry'));
          set('status', find('status'));
          set('remarks', find('remark'));
          set('engine', find('engine'));
          set('chassis', find('chassis'));
          set('year', find('mfg') ?? find('manufactur'));
          set('supplier', find('supplier'));
          break;
        }
      }
      if (!headerRow) continue;

      const rows: ParsedRow[] = [];
      for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const get = (key: string) => {
          const col = columns.get(key);
          return col ? text(row.getCell(col).value) : null;
        };
        const category = get('category');
        if (category && /^note\b/i.test(category)) break;
        const name = get('name');
        if (!name) continue;
        const parsed: ParsedRow = {
          line: r,
          category,
          name: name.replace(/\s+/g, ' '),
          make: get('make'),
          model: get('model'),
          registrationNo: get('registration'),
          ownership: ownershipOf(get('ownership')),
          location: get('location'),
          operator: get('operator'),
          purchaseDate: isoDate(
            row.getCell(columns.get('purchase') ?? 0).value,
          ),
          reading: numberOf(get('reading')),
          lastServiceDate: isoDate(
            row.getCell(columns.get('lastService') ?? 0).value,
          ),
          insuranceExpiry: isoDate(
            row.getCell(columns.get('expiry') ?? 0).value,
          ),
          status: statusOf(get('status')),
          remarks: get('remarks'),
          engineNo: get('engine'),
          chassisNo: get('chassis'),
          manufacturingYear: yearOf(get('year')),
          supplierName: get('supplier'),
          describesMachine: false,
        };
        parsed.describesMachine = Boolean(
          parsed.make ||
            parsed.model ||
            parsed.registrationNo ||
            parsed.engineNo ||
            parsed.chassisNo ||
            parsed.operator ||
            parsed.purchaseDate,
        );
        rows.push(parsed);
      }
      return rows;
    }
    return [];
  }
}

interface ParsedRow {
  line: number;
  category: string | null;
  name: string;
  make: string | null;
  model: string | null;
  registrationNo: string | null;
  ownership: EquipmentOwnership;
  location: string | null;
  operator: string | null;
  purchaseDate: string | null;
  reading: number | null;
  lastServiceDate: string | null;
  insuranceExpiry: string | null;
  status: EquipmentStatus | null;
  remarks: string | null;
  engineNo: string | null;
  chassisNo: string | null;
  manufacturingYear: number | null;
  supplierName: string | null;
  describesMachine: boolean;
}

function ownershipOf(value: string | null): EquipmentOwnership {
  if (value && /hire/i.test(value)) return EquipmentOwnership.hired;
  if (value && /lease/i.test(value)) return EquipmentOwnership.leased;
  return EquipmentOwnership.owned;
}

/** Working → active; Repair and Idle → inactive (only a maintenance job puts a machine under it). */
function statusOf(value: string | null): EquipmentStatus | null {
  if (!value) return null;
  if (/work|active/i.test(value)) return EquipmentStatus.active;
  if (/idle|repair|inactive/i.test(value)) return EquipmentStatus.inactive;
  return null;
}

function numberOf(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function yearOf(value: string | null): number | null {
  const match = value ? /\b(19|20)\d{2}\b/.exec(value) : null;
  return match ? Number(match[0]) : null;
}

/** A sheet date — a real date cell, or text as `15-05-2026`, `15/05/2026`, `15.05.2026` or ISO. */
function isoDate(value: ExcelJS.CellValue): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // An Excel serial date.
    return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  const raw = typeof value === 'string' ? value.trim() : '';
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw);
  if (match) {
    return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(
      2,
      '0',
    )}`;
  }
  return null;
}
