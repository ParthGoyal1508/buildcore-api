import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
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
  CreatePurchaseDto,
  ListPurchasesDto,
  UpdatePurchaseDto,
} from './dto/purchase.dto';
import { PurchasesService } from './purchases.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated purchase list with vendor, GRN and bill status',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListPurchasesDto,
  ) {
    return this.purchases.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a purchase',
    description:
      'One transaction: the purchase, a `purchase` ledger entry, the stock balance ' +
      'and its weighted average rate, an unpaid bill, and the GRN. The bill file is ' +
      "base64 in the JSON body, matching 007's contractor documents.",
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreatePurchaseDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.purchases.create(caller, dto, ipAddress, companyId);
  }

  @Get(':id/bill')
  @Header('Content-Type', 'application/octet-stream')
  @ApiOperation({ summary: 'Download the uploaded bill' })
  async bill(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { buffer } = await this.purchases.getBillFile(caller, id);
    return new StreamableFile(buffer);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a purchase',
    description:
      'Date and remarks only. Quantity, rate, item, store and vendor are what the ' +
      'ledger and the bill were computed from; correcting those is delete plus ' +
      're-create.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseDto,
    @Ip() ipAddress: string,
  ) {
    return this.purchases.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete a purchase and reverse its stock',
    description:
      '409 once a payment has been allocated against its bill — delete the payment ' +
      'first.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.purchases.remove(caller, id, ipAddress);
  }
}
