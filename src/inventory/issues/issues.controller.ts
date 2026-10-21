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
  CompositeChoicesDto,
  CompositePreviewDto,
  CreateIssueDto,
  ListIssuesDto,
  ReturnIssueDto,
} from './dto/issue.dto';
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

  @Get('composites')
  @ApiOperation({
    summary: 'Active composite items for the issue form (039)',
    description:
      'Each with its sub-items and their quantity per unit. Readable with INVENTORY alone; ' +
      'the recipes are edited under /inventory/composite-items.',
  })
  async compositeChoices(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: CompositeChoicesDto,
  ) {
    return this.issues.compositeChoices(caller, query);
  }

  @Get('composite-preview')
  @ApiOperation({
    summary: 'What a composite issue would take from a store (039)',
    description:
      'Per sub-item: the quantity required (quantity × qty per unit, rounded half-up to 3 ' +
      'decimals), what the store has, and any shortfall. Advisory; the issue re-checks under lock.',
  })
  async compositePreview(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: CompositePreviewDto,
  ) {
    return this.issues.compositePreview(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Issue material to work',
    description:
      'Locks the item-store balance for the transaction and refuses with 422 and ' +
      '`availableStock` when the quantity exceeds what is there. This is the single ' +
      'point of stock enforcement in the module (FR-003). With `compositeItemId` instead of ' +
      '`itemId` (039), every sub-item is issued in proportion under one slip and a shortfall ' +
      'refuses with 422 and `shortfalls` listing every short sub-item.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateIssueDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.issues.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id/return')
  @ApiOperation({
    summary: 'Record material returned to the store against an issue',
    description:
      'The total returned so far, when, and who received it. The stock goes back as ' +
      'reversing that much of the issue would.',
  })
  async returnMaterial(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReturnIssueDto,
    @Ip() ipAddress: string,
  ) {
    await this.issues.returnMaterial(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete an issue and return the material to stock',
    description:
      'A row of a composite issue (039) deletes and reverses its whole group in one transaction.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.issues.remove(caller, id, ipAddress);
  }
}
