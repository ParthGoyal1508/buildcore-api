import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CreateVendorDto, UpdateVendorDto } from './dto/vendor.dto';
import { ListVendorsDto } from './dto/list-vendors.dto';
import { VendorsService } from './vendors.service';

@ApiTags('Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PARTNERS)
@Controller('partners/vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated vendor list with search and filters' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListVendorsDto,
  ) {
    return this.vendors.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a vendor',
    description:
      'The vendor code is allocated from the company VENDORS series and cannot be ' +
      'supplied by the caller. Contacts and category tags are created with the vendor ' +
      'in one transaction.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateVendorDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.vendors.create(caller, dto, ipAddress, companyId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One vendor with contacts, categories and hire terms',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.vendors.findOne(caller, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a vendor',
    description:
      'Sending `contacts` or `categoryIds` REPLACES the existing list wholesale — ' +
      'omit the field to leave it untouched, send an empty array to clear it.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateVendorDto,
    @Ip() ipAddress: string,
  ) {
    return this.vendors.update(caller, id, dto, ipAddress);
  }

  @Get(':id/tds')
  @ApiOperation({
    summary: 'TDS section and rate for a vendor',
    description:
      'Deliberately narrow: Inventory and Machinery need only these two values when ' +
      'raising a bill, and should not have to fetch a whole vendor to get them.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        tdsSection: { type: 'string', nullable: true },
        tdsRate: { type: 'number', nullable: true },
      },
    },
  })
  async getTds(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.vendors.getTds(caller, id);
  }
}
