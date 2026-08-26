import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { TokenDto } from './dto/token.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @ApiOkResponse({ type: TokenDto })
  async signup(@Body() data: SignupDto): Promise<TokenDto> {
    data.email = data.email.toLowerCase();
    return this.auth.createUser(data);
  }

  @Post('login')
  @ApiOkResponse({ type: TokenDto })
  async login(@Body() { email, password }: LoginDto): Promise<TokenDto> {
    return this.auth.login(email.toLowerCase(), password);
  }

  @Post('refresh-token')
  @ApiOkResponse({ type: TokenDto })
  async refreshToken(@Body() { token }: RefreshTokenDto): Promise<TokenDto> {
    return this.auth.refreshToken(token);
  }
}
