import { PrismaService } from 'nestjs-prisma';
import { Injectable, BadRequestException } from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private passwordService: PasswordService,
  ) {}

  async updateUser(
    caller: AuthenticatedUser,
    newUserData: UpdateUserDto,
  ): Promise<AuthenticatedUser> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.user.update({
          data: newUserData,
          where: {
            id: caller.id,
          },
        }),
    );
    // Neither field this endpoint can change (firstname/lastname) affects roles.
    return {
      ...updated,
      permissions: caller.permissions,
      roleNames: caller.roleNames,
    };
  }

  async changePassword(
    caller: AuthenticatedUser,
    changePassword: ChangePasswordDto,
  ): Promise<AuthenticatedUser> {
    const passwordValid = await this.passwordService.validatePassword(
      changePassword.oldPassword,
      caller.password,
    );

    if (!passwordValid) {
      throw new BadRequestException('Invalid password');
    }

    const hashedPassword = await this.passwordService.hashPassword(
      changePassword.newPassword,
    );

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.user.update({
          data: {
            password: hashedPassword,
          },
          where: { id: caller.id },
        }),
    );
    return {
      ...updated,
      permissions: caller.permissions,
      roleNames: caller.roleNames,
    };
  }
}
