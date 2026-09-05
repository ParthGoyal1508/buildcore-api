import { ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Prisma } from '@prisma/client';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { callerFor, createPrismaMock } from '../testing/prisma-mock';

const SETTINGS_CONFIG = {
  defaultRates: {
    pfEmployer: 12,
    esicEmployer: 3.25,
    gratuity: 4.81,
    bonus: 8.33,
  },
  defaultPayrollLockDay: 7,
};

const configService = { get: () => SETTINGS_CONFIG };
const auditLog = { record: jest.fn() };
const documentTypes = { seedDefaultsForCompany: jest.fn() };
// 007 seeds the six default vendor categories alongside document types when a
// company is created; these tests assert on company creation, not on that seeding.
const vendorCategories = { seedDefaultsForCompany: jest.fn() };
// 009 seeds the ten default item categories the same way, for the same reason.
const itemCategories = { seedDefaultsForCompany: jest.fn() };
// 012 seeds the three asset masters likewise.
const assetCategories = { seedDefaultsForCompany: jest.fn() };
const assetDocTypes = { seedDefaultsForCompany: jest.fn() };
const conditionGrades = { seedDefaultsForCompany: jest.fn() };

const decimal = (n: number) => new Prisma.Decimal(n);
const companyRow = (over: Record<string, unknown> = {}) => ({
  id: 'company-1',
  shortCode: 'DC',
  pfEmployerRate: decimal(12),
  esicEmployerRate: decimal(3.25),
  gratuityRate: decimal(4.81),
  bonusRate: decimal(8.33),
  ...over,
});

describe('CompaniesService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('rejects a short code already in use, case-insensitively (FR-004)', async () => {
      const prisma = createPrismaMock({
        company: {
          findFirst: jest.fn().mockResolvedValue({ id: 'existing' }),
          create: jest.fn(),
        },
      });
      const service = new CompaniesService(
        prisma as never,
        configService as never,
        auditLog as never,
        documentTypes as never,
        vendorCategories as never,
        itemCategories as never,
        assetCategories as never,
        assetDocTypes as never,
        conditionGrades as never,
      );

      await expect(
        service.create(
          callerFor('company-1'),
          { name: 'Demo', shortCode: ' dc ' } as CreateCompanyDto,
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // Normalized before the lookup, so " dc " collides with a stored "DC".
      expect(prisma.tx.company.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { shortCode: { equals: 'DC', mode: 'insensitive' } },
        }),
      );
      expect(prisma.tx.company.create).not.toHaveBeenCalled();
    });

    it('falls back to the configured default rates when they are omitted (FR-002)', async () => {
      const create = jest.fn().mockResolvedValue(companyRow());
      const prisma = createPrismaMock({
        company: { findFirst: jest.fn().mockResolvedValue(null), create },
        employeeCodeSequence: { create: jest.fn() },
      });
      const service = new CompaniesService(
        prisma as never,
        configService as never,
        auditLog as never,
        documentTypes as never,
        vendorCategories as never,
        itemCategories as never,
        assetCategories as never,
        assetDocTypes as never,
        conditionGrades as never,
      );

      await service.create(
        callerFor('company-1'),
        { name: 'Demo Constructions', shortCode: 'dc' } as CreateCompanyDto,
        '127.0.0.1',
      );

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          shortCode: 'DC',
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
          payrollLockDay: 7,
        }),
      });
    });

    it('keeps explicitly supplied rates instead of the defaults', async () => {
      const create = jest.fn().mockResolvedValue(companyRow());
      const prisma = createPrismaMock({
        company: { findFirst: jest.fn().mockResolvedValue(null), create },
        employeeCodeSequence: { create: jest.fn() },
      });
      const service = new CompaniesService(
        prisma as never,
        configService as never,
        auditLog as never,
        documentTypes as never,
        vendorCategories as never,
        itemCategories as never,
        assetCategories as never,
        assetDocTypes as never,
        conditionGrades as never,
      );

      await service.create(
        callerFor('company-1'),
        {
          name: 'Demo',
          shortCode: 'dc',
          pfEmployerRate: 10,
        } as CreateCompanyDto,
        '127.0.0.1',
      );

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pfEmployerRate: 10,
          gratuityRate: 4.81,
        }),
      });
    });

    it('seeds default document types and a code sequence for the new company', async () => {
      const seqCreate = jest.fn();
      const prisma = createPrismaMock({
        company: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(companyRow()),
        },
        employeeCodeSequence: { create: seqCreate },
      });
      const service = new CompaniesService(
        prisma as never,
        configService as never,
        auditLog as never,
        documentTypes as never,
        vendorCategories as never,
        itemCategories as never,
        assetCategories as never,
        assetDocTypes as never,
        conditionGrades as never,
      );

      await service.create(
        callerFor('company-1'),
        { name: 'Demo', shortCode: 'DC' } as CreateCompanyDto,
        '127.0.0.1',
      );

      expect(documentTypes.seedDefaultsForCompany).toHaveBeenCalledWith(
        'company-1',
        prisma.tx,
      );
      expect(seqCreate).toHaveBeenCalledWith({
        data: { companyId: 'company-1', lastNumber: 0 },
      });
    });
  });

  describe('update', () => {
    it('rejects a short code that collides with a different company', async () => {
      const prisma = createPrismaMock({
        company: {
          findUnique: jest.fn().mockResolvedValue(companyRow()),
          findFirst: jest.fn().mockResolvedValue({ id: 'other' }),
          update: jest.fn(),
        },
      });
      const service = new CompaniesService(
        prisma as never,
        configService as never,
        auditLog as never,
        documentTypes as never,
        vendorCategories as never,
        itemCategories as never,
        assetCategories as never,
        assetDocTypes as never,
        conditionGrades as never,
      );

      await expect(
        service.update(
          callerFor('company-1'),
          'company-1',
          { shortCode: 'ACME' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.company.update).not.toHaveBeenCalled();
    });

    it('404s on a company that does not exist', async () => {
      const prisma = createPrismaMock({
        company: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      const service = new CompaniesService(
        prisma as never,
        configService as never,
        auditLog as never,
        documentTypes as never,
        vendorCategories as never,
        itemCategories as never,
        assetCategories as never,
        assetDocTypes as never,
        conditionGrades as never,
      );
      await expect(
        service.update(
          callerFor('company-1'),
          'nope',
          { name: 'x' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listActiveForOtherModules', () => {
    it('returns only active companies (FR-005)', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = createPrismaMock({ company: { findMany } });
      const service = new CompaniesService(
        prisma as never,
        configService as never,
        auditLog as never,
        documentTypes as never,
        vendorCategories as never,
        itemCategories as never,
        assetCategories as never,
        assetDocTypes as never,
        conditionGrades as never,
      );

      await service.listActiveForOtherModules();

      expect(findMany).toHaveBeenCalledWith({
        where: { status: 'active' },
        orderBy: { name: 'asc' },
      });
    });
  });
});

describe('CreateCompanyDto validation (research.md §10)', () => {
  const errorsFor = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(CreateCompanyDto, {
      name: 'Demo',
      shortCode: 'DC',
      ...payload,
    });
    const errors = await validate(dto);
    return errors.map((e) => e.property);
  };

  it('accepts a well-formed GSTIN and PAN', async () => {
    await expect(
      errorsFor({ gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' }),
    ).resolves.toEqual([]);
  });

  it('rejects a malformed GSTIN', async () => {
    await expect(errorsFor({ gstin: 'NOT-A-GSTIN' })).resolves.toContain(
      'gstin',
    );
  });

  it('rejects a malformed PAN', async () => {
    await expect(errorsFor({ pan: 'AAPFU0939' })).resolves.toContain('pan');
  });

  it('rejects a short code with illegal characters', async () => {
    await expect(errorsFor({ shortCode: 'D C!' })).resolves.toContain(
      'shortCode',
    );
  });
});
