import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class AdminResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  targetAccountId: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(8)
  temporaryPassword: string;
}
