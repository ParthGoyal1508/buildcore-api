import { ConflictException, Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  VendorCategoriesService as SettingsVendorCategoriesService,
  VendorCategoryView,
} from '../../settings/vendor-categories/vendor-categories.service';
import {
  CreateVendorCategoryDto,
  UpdateVendorCategoryDto,
} from '../../settings/vendor-categories/dto/vendor-category.dto';
import { VendorsService } from '../vendors/vendors.service';

export interface VendorCategoryWithUsage extends VendorCategoryView {
  /** How many vendors are tagged with this category — drives both the list column
   * and whether the delete control is offered. */
  vendorCount: number;
}

/**
 * The partners-side composition of the vendor category master.
 *
 * The table lives in `settings` and its CRUD lives with it. What lives here is the
 * one rule that needs both modules: a category may not be deleted while a vendor
 * still deals in it (FR-014). Answering that means counting `partners.VendorDealsIn`
 * rows, which the settings module may not read — Principle I — and asking settings
 * to import partners would make the dependency circular.
 *
 * So the guard sits on this side, where the count is local, and delegates the write
 * to the module that owns the row. Note the contrast with `ReferenceDataService`,
 * whose equivalent guard is still a stub returning `false` because it was written
 * before the referencing module existed.
 */
@Injectable()
export class PartnerVendorCategoriesService {
  constructor(
    private readonly categories: SettingsVendorCategoriesService,
    private readonly vendors: VendorsService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<VendorCategoryWithUsage[]> {
    const rows = await this.categories.findAll(caller, companyId);
    return Promise.all(
      rows.map(async (category) => ({
        ...category,
        vendorCount: await this.vendors.countInCategory(caller, category.id),
      })),
    );
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateVendorCategoryDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<VendorCategoryWithUsage> {
    const created = await this.categories.create(
      caller,
      dto,
      ipAddress,
      companyId,
    );
    return { ...created, vendorCount: 0 };
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateVendorCategoryDto,
    ipAddress: string,
  ): Promise<VendorCategoryWithUsage> {
    const updated = await this.categories.update(caller, id, dto, ipAddress);
    return {
      ...updated,
      vendorCount: await this.vendors.countInCategory(caller, id),
    };
  }

  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    // Checked before delegating rather than caught afterwards: there is no foreign
    // key between the schemas to raise the violation, so nothing else would stop it.
    const inUse = await this.vendors.countInCategory(caller, id);
    if (inUse > 0) {
      throw new ConflictException(
        `This category is still used by ${inUse} vendor${
          inUse === 1 ? '' : 's'
        }. ` + 'Retag them before deleting it.',
      );
    }
    await this.categories.remove(caller, id, ipAddress);
  }
}
