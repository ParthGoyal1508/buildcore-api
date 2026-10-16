import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PASSWORD_COMPLEXITY } from '../account-creation/constants/account-creation.constants';
import { ChangePasswordDto } from '../users/dto/change-password.dto';
import { generateTemporaryPassword } from './password-policy';

/** One password rule everywhere a new password is chosen (029 FR-005). */
describe('password policy', () => {
  it('generates temporary passwords that always pass the rule and never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(PASSWORD_COMPLEXITY);
      expect(password).toHaveLength(12);
      // Nothing that reads ambiguously off a screen or down a phone.
      expect(password).not.toMatch(/[0O1lI]/);
      seen.add(password);
    }
    expect(seen.size).toBe(500);
  });

  const errorsFor = async (newPassword: string) =>
    (
      await validate(
        plainToInstance(ChangePasswordDto, {
          oldPassword: 'whatever-old',
          newPassword,
        }),
      )
    ).map((e) => e.property);

  it('holds a self-service change to the same rule as an invite', async () => {
    await expect(errorsFor('Abcdefg1')).resolves.toEqual([]);
    await expect(errorsFor('abcdefgh')).resolves.toContain('newPassword');
    await expect(errorsFor('ABCDEFGH')).resolves.toContain('newPassword');
    await expect(errorsFor('Abc1')).resolves.toContain('newPassword');
  });

  it('refuses a password long enough to be a hashing cost rather than a password', async () => {
    await expect(errorsFor(`A1${'x'.repeat(127)}`)).resolves.toContain(
      'newPassword',
    );
    await expect(errorsFor(`A1${'x'.repeat(126)}`)).resolves.toEqual([]);
  });
});
