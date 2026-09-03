import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { ContractorsService } from './contractors.service';
import {
  CreateContractorDocumentDto,
  CreateContractorDto,
  ListContractorsDto,
  UpdateContractorDto,
} from './dto/contractor.dto';

@ApiTags('Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PARTNERS)
@Controller('partners/contractors')
export class ContractorsController {
  constructor(private readonly contractors: ContractorsService) {}

  @Get()
  @ApiOperation({
    summary: 'Contractor profiles for active vendors',
    description:
      'Contractors of deactivated vendors are excluded — an engagement you have ' +
      'ended does not belong on a list of who owes filings.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListContractorsDto,
  ) {
    return this.contractors.findAll(caller, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a contractor profile for a vendor' })
  @ApiBadRequestResponse({
    description: 'The vendor is not a subcontractor or labour contractor',
  })
  @ApiConflictResponse({ description: 'The vendor already has a profile' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateContractorDto,
    @Ip() ipAddress: string,
  ) {
    return this.contractors.create(caller, dto, ipAddress);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One contractor with its documents and their expiry warnings',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.contractors.findOne(caller, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a contractor’s registration numbers' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateContractorDto,
    @Ip() ipAddress: string,
  ) {
    return this.contractors.update(caller, id, dto, ipAddress);
  }

  @Post(':id/documents')
  @ApiOperation({ summary: 'Attach a statutory document, base64-encoded' })
  async uploadDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateContractorDocumentDto,
    @Ip() ipAddress: string,
  ) {
    return this.contractors.uploadDocument(caller, id, dto, ipAddress);
  }

  @Delete('documents/:documentId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a contractor document and its stored file' })
  async deleteDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('documentId') documentId: string,
    @Ip() ipAddress: string,
  ) {
    await this.contractors.deleteDocument(caller, documentId, ipAddress);
  }
}
