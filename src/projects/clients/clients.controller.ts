import {
  Body,
  Controller,
  Delete,
  Get,
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
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { ListClientsDto } from './dto/list-clients.dto';
import { UpdateClientDto } from './dto/update-client.dto';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECTS)
@Controller('projects/clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated client list with search and status filter',
    description:
      'Each row carries `projectCount`, so the caller can tell before trying that a ' +
      'delete will be refused.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListClientsDto,
  ) {
    return this.clients.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a client',
    description:
      'A cross-company caller may name the company with `?companyId=`; without it ' +
      "the client is created in the caller's own company.",
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateClientDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.clients.create(caller, dto, ipAddress, companyId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One client' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.clients.findOne(caller, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a client',
    description:
      'Partial: only the fields present in the body are written. Omit a field to ' +
      'leave it untouched, send null or an empty string to clear it.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
    @Ip() ipAddress: string,
  ) {
    return this.clients.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a client with no linked projects',
    description: 'Returns 409 naming the linked project count if any exist.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.clients.remove(caller, id, ipAddress);
  }
}
