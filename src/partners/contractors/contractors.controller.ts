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
  Res,
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
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
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

  // Three segments, so it never collides with `GET :id` (036 N4, 2026-10-17).
  @Get('documents/:documentId/file')
  @ApiOperation({
    summary: 'The stored file of a contractor document',
    description:
      'Served with its detected content type and the uploader’s file name. 404 for a ' +
      'document outside the caller’s company, the same as one that does not exist.',
  })
  async documentFile(
    @UserEntity() caller: AuthenticatedUser,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ) {
    const file = await this.contractors.documentFile(caller, documentId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', contentDispositionFor(file.filename));
    res.send(file.buffer);
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
