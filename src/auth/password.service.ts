import { Injectable } from '@nestjs/common';
import { hash, verify } from 'argon2';

@Injectable()
export class PasswordService {
  /**
   * Compares a submitted password against a stored hash.
   *
   * Returns false for a missing hash rather than passing it to argon2, which throws
   * `TypeError: pchstr must be a non-empty string` on null. That case is real, not
   * defensive: feature 010 made `shared.User.password` nullable so an invited account
   * can exist before its owner has chosen one, and login reaches this before it
   * checks account status. Without this guard, any pending account turns
   * `POST /auth/login` into a 500 for that email — and since an unknown address
   * returns a clean 401, the difference is an account-enumeration oracle that
   * defeats the deliberately generic message 001 chose.
   *
   * Guarded here rather than at each call site so a future caller cannot
   * reintroduce it: an account with no password simply has no valid credential.
   */
  validatePassword(
    password: string,
    hashedPassword: string | null | undefined,
  ): Promise<boolean> {
    if (!hashedPassword) {
      return Promise.resolve(false);
    }
    return verify(hashedPassword, password);
  }

  hashPassword(password: string): Promise<string> {
    return hash(password);
  }
}
