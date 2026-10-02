import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import {
  CreateLetterKindDto,
  UpdateLetterKindDto,
} from './dto/letter-kind.dto';
import { LetterKindsService } from './letter-kinds.service';
import { LetterKindFieldsService } from './letter-kind-fields.service';
import { UpsertLetterKindFieldDto } from './dto/letter-kind-field.dto';
import { resolveCompanyId } from '../company-scope';

/**
 * Letter kinds as data (017 US5, FR-011, FR-022).
 *
 * The whole point of this controller is that it exists. Before 017 a new letter kind
 * was an enum value: a schema change, a migration and a release. FR-011 says defining
 * one must not need a code change, and these four routes are what makes that literally
 * true.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('letter-kinds')
export class LetterKindsController {
  constructor(
    private readonly kinds: LetterKindsService,
    /**
     * Trailing underscore because `fields` is also a route handler's name on this class, and the two
     * would shadow each other. Renaming the handler would change the method name a reader greps for.
     */
    private readonly fields_: LetterKindFieldsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every kind this company may use — its own, plus the shipped ones',
    description:
      '`isShipped` distinguishes the two. A shipped kind may not be edited or deleted: ' +
      'other companies use the same row.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.kinds.listFor(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      { includeInactive: includeInactive === 'true' },
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Define a new letter kind',
    description:
      'Refuses a key the product already ships — `LETTER_KIND_KEY_RESERVED` (FR-011a). ' +
      'Two kinds answering to one key leave every lookup ambiguous with no precedence ' +
      'rule to settle it.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateLetterKindDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.kinds.create(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress },
    );
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Edit a kind’s label and behaviour',
    description:
      'The `key` is deliberately not editable: issued letters, templates and 016 action ' +
      'types all match on it, and renaming it would orphan every one of them silently.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLetterKindDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.kinds.update(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      id,
      dto,
      { userId: caller.id, ipAddress },
    );
  }

  @Get(':id/fields')
  @ApiOperation({
    summary: 'The fields this kind’s templates may use (FR-011b)',
    description:
      'What the template editor offers. Each field names **where its value comes from**, because a ' +
      'field that is only a label is a placeholder that renders blank — and a blank in a signed ' +
      'letter is indistinguishable from a deliberate omission.',
  })
  async fields(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.fields_.fieldsFor(rlsContextFor(caller), id);
  }

  @Put(':id/fields/:token')
  @ApiOperation({
    summary: 'Declare or redefine one field on this kind (FR-011b, FR-011c)',
    description:
      'An upsert on the token, because editing a label or a source is the common case and a ' +
      'delete-then-create would briefly leave saved templates referencing a field their kind did ' +
      'not declare.\n\n' +
      'A path naming regulated personal data is refused outright: **defining a kind does not grant ' +
      'a way past FR-024.**',
  })
  @ApiResponse({
    status: 400,
    description:
      'The path is missing, forbidden, or supplied for a `manual` field.',
  })
  async declareField(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('token') token: string,
    @Body() dto: UpsertLetterKindFieldDto,
  ) {
    // The path's token wins over the body's, so a mismatched pair cannot create a field at one name
    // while the caller believes they edited another.
    return this.fields_.upsertField(rlsContextFor(caller), id, {
      ...dto,
      token,
    });
  }

  @Delete(':id/fields/:token')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Withdraw a field from this kind',
    description:
      'Not refused while templates use it. An administrator tidying a kind should not be blocked by ' +
      'a draft somebody abandoned — instead issuing refuses, naming the removed field, so the ' +
      'failure lands on the person issuing rather than on the person tidying.',
  })
  async withdrawField(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('token') token: string,
  ) {
    await this.fields_.removeField(rlsContextFor(caller), id, token);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a kind nothing references',
    description:
      '`409 LETTER_KIND_IN_USE` while letters or templates still point at it (FR-022). ' +
      'The `onDelete: Restrict` foreign key is the guarantee; the code is the message.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    await this.kinds.remove(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      id,
      { userId: caller.id, ipAddress },
    );
  }
}
