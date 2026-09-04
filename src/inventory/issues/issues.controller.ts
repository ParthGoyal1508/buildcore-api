import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
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
import { CreateIssueDto, ListIssuesDto } from './dto/issue.dto';
import { IssuesService } from './issues.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/issues')
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated issue list' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListIssuesDto,
  ) {
    return this.issues.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Issue material to work',
    description:
      'Locks the item-store balance for the transaction and refuses with 422 and ' +
      '`availableStock` when the quantity exceeds what is there. This is the single ' +
      'point of stock enforcement in the module (FR-003).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateIssueDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.issues.create(caller, dto, ipAddress, companyId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete an issue and return the material to stock',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.issues.remove(caller, id, ipAddress);
  }
}
