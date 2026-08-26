import { Injectable } from '@nestjs/common';
import { hash, verify } from 'argon2';

@Injectable()
export class PasswordService {
  validatePassword(password: string, hashedPassword: string): Promise<boolean> {
    return verify(hashedPassword, password);
  }

  hashPassword(password: string): Promise<string> {
    return hash(password);
  }
}
