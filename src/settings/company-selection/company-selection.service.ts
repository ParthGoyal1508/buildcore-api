import { ForbiddenException, Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { withRlsContext } from '../../common/prisma/rls-context';

export interface SelectableCompany {
  id: string;
  name: string;
  selected: boolean;
  /**
   * Whether this company has supplied its own logo (2026-10-12).
   *
   * A flag rather than letting the shell try `GET /settings/companies/:id/logo` and
   * handle the 404: the shell renders on every page, and a company with no logo would
   * otherwise spend a failed request per navigation establishing a fact that never
   * changes within a session. The interface shows the product mark when this is false.
   */
  hasLogo: boolean;
}

/**
 * Which company a user is working in (019 FR-008 to FR-013).
 *
 * The one rule this service exists to enforce: **a selection may narrow a caller's scope and
 * never widen it.** Everything below follows from that — the accessible set is derived from the
 * caller's permissions rather than from anything they send, the stored row is re-validated on
 * every read rather than trusted, and an invalid selection resolves to the caller's own company
 * instead of being honoured or erroring.
 */
@Injectable()
export class CompanySelectionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The companies this caller may work in.
   *
   * One element for most people, which is how the interface satisfies FR-013 — no switcher for
   * a single-company user — without a second call to ask whether to offer one.
   */
  async selectableFor(caller: AuthenticatedUser): Promise<SelectableCompany[]> {
    const selected = await this.resolve(caller);

    if (!caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) {
      if (!caller.companyId) return [];
      const own = await withRlsContext(
        this.prisma,
        { isSuperAdmin: false, companyId: caller.companyId },
        (tx) =>
          tx.company.findUnique({
            where: { id: caller.companyId as string },
            select: { id: true, name: true, logoRef: true },
          }),
      );
      return own
        ? [
            {
              id: own.id,
              name: own.name,
              selected: true,
              hasLogo: own.logoRef !== null,
            },
          ]
        : [];
    }

    const companies = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findMany({
          select: { id: true, name: true, logoRef: true },
          orderBy: { name: 'asc' },
        }),
    );
    return companies.map((company) => ({
      id: company.id,
      name: company.name,
      selected: company.id === (selected ?? caller.companyId),
      // The reference itself is never sent: it is a storage path, and the only thing a
      // caller can do with it is ask this API for the bytes, which it does by company id.
      hasLogo: company.logoRef !== null,
    }));
  }

  /**
   * Records a selection, refusing a company the caller may not reach.
   *
   * **403, not 404.** A 404 would tell a caller which company ids exist, which is a small
   * enumeration oracle for anyone holding a single company.
   */
  async select(
    caller: AuthenticatedUser,
    companyId: string,
  ): Promise<SelectableCompany[]> {
    const allowed = await this.selectableFor(caller);
    if (!allowed.some((company) => company.id === companyId)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'COMPANY_NOT_ACCESSIBLE',
        message: 'You do not have access to that company.',
      });
    }

    /**
     * Written **unscoped**, and that is the only context this write can have.
     *
     * It used to run with `{ isSuperAdmin: false, companyId }` — the company being switched
     * *to*. Under that context Postgres refused the write outright:
     *
     *     42501 new row violates row-level security policy (USING expression)
     *            for table "UserCompanySelection"
     *
     * because the row is keyed by user and this statement **moves it between tenants**.
     * Prisma's upsert is `INSERT ... ON CONFLICT DO UPDATE`, and on conflict Postgres applies
     * the policy's USING to the row *already there* — which still holds the previous company.
     * So the first selection worked and every switch after it failed: a user could choose a
     * company once and was then stuck in it.
     *
     * No tenant context can satisfy both halves. The old company passes USING and fails WITH
     * CHECK; the new one does the reverse. A row that names which tenant somebody is moving to
     * is not a row that belongs to a tenant.
     *
     * Nothing is given away by this. The target was authorised two lines above by
     * `selectableFor`, the key is the caller's own id so no other user's row is reachable, and
     * the policy's own migration says it "does not make the selection authorisation ... whether
     * they may choose it is checked in the service". `resolve` and `clear` already read and
     * delete this row the same way.
     *
     * **It passed every test for four days because the local and CI database role is a
     * superuser**, and Postgres exempts superusers from RLS unconditionally — so the policy was
     * never in force here. `test/company-selection-rls.e2e-spec.ts` now asks under a role that
     * cannot bypass it, which is the only way this is observable outside production.
     */
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.userCompanySelection.upsert({
        where: { userId: caller.id },
        create: { userId: caller.id, companyId },
        update: { companyId },
      }),
    );

    return (await this.selectableFor(caller)).map((company) => ({
      ...company,
      selected: company.id === companyId,
    }));
  }

  /**
   * The caller's effective selection, **re-validated** (FR-012's edge case).
   *
   * Called on every request through the JWT strategy, not only on write. A stored selection is
   * a record of a past choice, not a standing grant: if the caller's cross-company access has
   * since been revoked, honouring it would be a cross-tenant read. So a selection they may no
   * longer use resolves to their own company and the stale row is removed — cleaning up rather
   * than leaving something that will be re-checked and re-rejected on every future request.
   */
  async resolve(caller: {
    id: string;
    companyId: string | null;
    permissions: Permission[];
  }): Promise<string | null> {
    // A single-company caller has nothing to select: their own company always wins, so there is
    // no point reading the row at all.
    if (!caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) {
      return null;
    }

    // One transaction for both reads: this runs on every authenticated request, and each
    // transaction costs several round trips to the database before the read itself.
    const { row, company } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        const row = await tx.userCompanySelection.findUnique({
          where: { userId: caller.id },
        });
        const company = row
          ? await tx.company.findUnique({
              where: { id: row.companyId },
              select: { id: true },
            })
          : null;
        return { row, company };
      },
    );
    if (!row) return null;

    if (!company) {
      await this.clear(caller.id);
      return null;
    }

    return row.companyId;
  }

  /** Removes a stale selection. */
  private async clear(userId: string): Promise<void> {
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.userCompanySelection.deleteMany({ where: { userId } }),
    );
  }
}
