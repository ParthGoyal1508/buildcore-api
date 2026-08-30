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
  ApiConflictResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  DocumentTypeView,
  DocumentTypesService,
} from './document-types.service';
import {
  CreateDocumentTypeDto,
  UpdateDocumentTypeDto,
} from './dto/document-type.dto';

/**
 * No `DELETE`: document types are deactivated via `isActive: false` rather than
 * removed, so historical employee records referencing them stay intact (FR-019,
 * contracts/settings-api.md).
 */
@ApiTags('settings/document-types')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('settings/document-types')
export class DocumentTypesController {
  constructor(private readonly documentTypes: DocumentTypesService) {}

  @Get()
  @ApiOperation({
    summary: "List this company's document types",
    description:
      'Each row carries its derived display flag, computed on read from the three stored booleans.',
  })
  @ApiQuery({
    name: 'companyId',
    required: false,
    description:
      'Narrows the list to one company. Honoured only for a caller holding CROSS_COMPANY_ACCESS; ignored for everyone else, who is always pinned to their own company.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ): Promise<DocumentTypeView[]> {
    return this.documentTypes.findAll(caller, companyId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a document type' })
  @ApiConflictResponse({ description: 'Code already used within this company' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateDocumentTypeDto,
    @Ip() ipAddress: string,
  ): Promise<DocumentTypeView> {
    return this.documentTypes.create(caller, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a document type, or deactivate it with `isActive: false`',
  })
  @ApiConflictResponse({ description: 'Code already used within this company' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDocumentTypeDto,
    @Ip() ipAddress: string,
  ): Promise<DocumentTypeView> {
    return this.documentTypes.update(caller, id, dto, ipAddress);
  }
}
