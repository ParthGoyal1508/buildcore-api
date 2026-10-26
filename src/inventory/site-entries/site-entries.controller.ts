import {
  Body,
  Controller,
  Get,
  Ip,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  CreateSiteEntryDto,
  SiteEntryItemsQueryDto,
} from './dto/site-entry.dto';
import { SiteEntriesService } from './site-entries.service';

/**
 * The site's "Create Inventory Purchase" page (043). Its own permission and its own path, so a
 * caller who holds only this can record a delivery and reach nothing else of Inventory: there is
 * no list, read, edit or delete here, and `inventory/purchases` stays behind `INVENTORY`.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY_SITE_ENTRY)
@Controller('inventory/site-entries')
export class SiteEntriesController {
  constructor(private readonly siteEntries: SiteEntriesService) {}

  @Get('stores')
  @ApiOperation({
    summary: 'The stores the caller may record a delivery against',
    description:
      'Their assigned sites. Empty when none is assigned — the page blocks, and a create is refused ' +
      'with 403 `SITE_ENTRY_NO_STORE`.',
  })
  async stores(@UserEntity() caller: AuthenticatedUser) {
    return this.siteEntries.myStores(caller);
  }

  @Get('items')
  @ApiOperation({
    summary: 'Active items for the picker — the item master Head Office uses',
  })
  async items(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: SiteEntryItemsQueryDto,
  ) {
    return this.siteEntries.items(caller, query.search);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a delivery at the site, partially filled',
    description:
      'Saved as `partial_site` for Head Office to complete; moves no stock. The store is the ' +
      "caller's assignment. The photo's location must be inside the site's geofence by the " +
      'attendance rule (radius plus reported accuracy), checked here: 422 ' +
      '`SITE_ENTRY_REFUSED_LOCATION`, `SITE_ENTRY_REFUSED_UNLOCATABLE` or ' +
      '`SITE_ENTRY_REFUSED_STALE_PHOTO`. Resending a `clientRequestId` returns the entry saved.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateSiteEntryDto,
    @Ip() ipAddress: string,
  ) {
    return this.siteEntries.create(caller, dto, ipAddress);
  }
}
