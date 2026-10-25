import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
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
  CompletePurchaseDto,
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
  @ApiOperation({ summary: 'Download the uploaded bill' })
  async bill(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    // Typed from the bytes (036 M11), so a PDF or photo opens inline rather than downloading.
    const { buffer, contentType } = await this.purchases.getBillFile(
      caller,
      id,
    );
    return new StreamableFile(buffer, { type: contentType });
  }

  @Get(':id/photo')
  @ApiOperation({
    summary: 'The delivery photograph taken at the gate (036 M11)',
    description:
      "`n` picks which, from 1 (default) to the purchase's `photoCount` — a site entry may carry " +
      'up to five (043).',
  })
  async photo(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Query('n', new DefaultValuePipe(1), ParseIntPipe) n: number,
  ): Promise<StreamableFile> {
    const { buffer, contentType } = await this.purchases.getPhotoFile(
      caller,
      id,
      n,
    );
    return new StreamableFile(buffer, { type: contentType });
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'The change history of a purchase, oldest first (043)',
  })
  async history(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.purchases.history(caller, id);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'Complete a site entry (043)',
    description:
      'Head Office adds the vendor, quantity, rate and bill to a delivery the site recorded, and ' +
      'only then does it move stock — the same ledger entry, balance, bill and GRN as creating a ' +
      'purchase. 409 when it is already completed.',
  })
  async complete(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CompletePurchaseDto,
    @Ip() ipAddress: string,
  ) {
    return this.purchases.complete(caller, id, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a purchase',
    description:
      'Date and remarks only. Quantity, rate, item, store and vendor are what the ' +
      'ledger and the bill were computed from; correcting those is delete plus ' +
      're-create. A site entry Head Office has not completed (043) may also have its ' +
      'item and vehicle number corrected; each change is kept in its history.',
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
