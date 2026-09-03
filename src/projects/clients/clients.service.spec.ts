import { ConflictException } from '@nestjs/common';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { ClientsService } from './clients.service';

/**
 * The two paths a client can be refused on, both of which 007's equivalents shipped
 * without and had to be retrofitted.
 */
describe('ClientsService', () => {
  const caller = callerFor('company-1');
  const audit = { record: jest.fn() };

  const serviceWith = (delegates: Record<string, unknown>) => {
    const prisma = createPrismaMock(delegates);
    return {
      prisma,
      service: new ClientsService(prisma as never, audit as never),
    };
  };

  beforeEach(() => audit.record.mockReset());

  describe('create', () => {
    it('refuses a GSTIN already on file, naming the client that holds it', async () => {
      const { service } = serviceWith({
        client: {
          findFirst: jest.fn().mockResolvedValue({ name: 'Acme Infra' }),
          create: jest.fn(),
        },
      });

      await expect(
        service.create(
          caller,
          { name: 'Acme Infrastructure', gstin: '27AAPFU0939F1ZV' },
          '10.0.0.1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('names the existing holder in the message, so the caller can find it', async () => {
      const { service } = serviceWith({
        client: {
          findFirst: jest.fn().mockResolvedValue({ name: 'Acme Infra' }),
          create: jest.fn(),
        },
      });

      await expect(
        service.create(
          caller,
          { name: 'Acme Infrastructure', gstin: '27AAPFU0939F1ZV' },
          '10.0.0.1',
        ),
      ).rejects.toThrow(/Acme Infra/);
    });

    it('does not look for a GSTIN clash when no GSTIN was supplied', async () => {
      // Otherwise every GSTIN-less client would collide with the first one, since a
      // `gstin: undefined` filter matches any row.
      const findFirst = jest.fn();
      const { service } = serviceWith({
        client: {
          findFirst,
          create: jest
            .fn()
            .mockResolvedValue({ id: 'client-1', companyId: 'company-1' }),
        },
      });

      await service.create(caller, { name: 'No GSTIN Ltd' }, '10.0.0.1');
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('audits the create against the company the row landed in', async () => {
      const { service } = serviceWith({
        client: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest
            .fn()
            .mockResolvedValue({ id: 'client-1', companyId: 'company-1' }),
        },
      });

      await service.create(caller, { name: 'Acme' }, '10.0.0.1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'CLIENT',
          action: 'CREATE',
          entityId: 'client-1',
          companyId: 'company-1',
        }),
      );
    });
  });

  describe('remove', () => {
    it('refuses to delete a client with linked projects, and says how many', async () => {
      const deleteFn = jest.fn();
      const { service } = serviceWith({
        client: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'client-1',
            companyId: 'company-1',
            name: 'Acme Infra',
            _count: { projects: 3 },
          }),
          delete: deleteFn,
        },
      });

      await expect(
        service.remove(caller, 'client-1', '10.0.0.1'),
      ).rejects.toThrow(/3 linked project\(s\)/);
      // The point of checking first is that nothing is attempted — a RESTRICT
      // violation would surface as an opaque database error instead.
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('deletes and audits when no project references the client', async () => {
      const deleteFn = jest.fn().mockResolvedValue({});
      const { service } = serviceWith({
        client: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'client-1',
            companyId: 'company-1',
            name: 'Unused Ltd',
            _count: { projects: 0 },
          }),
          delete: deleteFn,
        },
      });

      await expect(
        service.remove(caller, 'client-1', '10.0.0.1'),
      ).resolves.toEqual({ id: 'client-1' });
      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'client-1' } });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'CLIENT', action: 'DELETE' }),
      );
    });
  });
});
