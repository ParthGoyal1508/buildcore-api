import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
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
  CreateTransferDto,
  ListTransfersDto,
  UpdateTransferDto,
} from './dto/transfer.dto';
import { TransfersService } from './transfers.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated transfer list' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListTransfersDto,
  ) {
    return this.transfers.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Move material between stores',
    description:
      'Both balances move now, not on receipt: the material has left the source ' +
      'store, and holding the decrement would leave the same units issuable from ' +
      'it. 400 for the same store on both sides, 422 when the source is short.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateTransferDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.transfers.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Advance the physical movement status',
    description: 'pending → in_transit → received. 409 out of order.',
  })
  async updateStatus(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTransferDto,
    @Ip() ipAddress: string,
  ) {
    return this.transfers.updateStatus(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete a transfer and revert both balances',
    description: '409 once the destination has confirmed receipt.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.transfers.remove(caller, id, ipAddress);
  }
}
