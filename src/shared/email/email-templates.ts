/**
 * Message bodies, defined as constants rather than inline in the adapters
 * (Constitution Principle III) so wording can change without touching delivery code,
 * and so both adapters render identically.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function renderInviteEmail(input: {
  setPasswordUrl: string;
  isResend: boolean;
  expiresAt: Date;
}): RenderedEmail {
  const { setPasswordUrl, isResend, expiresAt } = input;
  const expiry = expiresAt.toUTCString();
  const subject = isResend
    ? 'Your new BuildCore invite link'
    : 'Set up your BuildCore account';

  // A resend says so explicitly. Someone who already clicked a dead link needs to
  // know this one replaces it, rather than wondering which of two mails is current.
  const opening = isResend
    ? 'Here is a new link to set up your BuildCore account. Any earlier link no longer works.'
    : 'An administrator has created a BuildCore account for you.';

  const text = [
    opening,
    '',
    'Set your password:',
    setPasswordUrl,
    '',
    `This link can be used once and expires on ${expiry}.`,
    'If you were not expecting this, you can ignore this email.',
  ].join('\n');

  const html = [
    `<p>${escapeHtml(opening)}</p>`,
    `<p><a href="${escapeHtml(setPasswordUrl)}">Set your password</a></p>`,
    `<p>This link can be used once and expires on ${escapeHtml(expiry)}.</p>`,
    '<p>If you were not expecting this, you can ignore this email.</p>',
  ].join('\n');

  return { subject, text, html };
}

export function renderAccountLockedEmail(input: {
  unlockAt: Date;
}): RenderedEmail {
  const unlock = input.unlockAt.toUTCString();
  const subject = 'Your BuildCore account is temporarily locked';
  const body =
    'Your BuildCore account was locked after several failed sign-in attempts.';

  const text = [
    body,
    '',
    `You can try again after ${unlock}.`,
    'If this was not you, contact your administrator.',
  ].join('\n');

  const html = [
    `<p>${escapeHtml(body)}</p>`,
    `<p>You can try again after ${escapeHtml(unlock)}.</p>`,
    '<p>If this was not you, contact your administrator.</p>',
  ].join('\n');

  return { subject, text, html };
}

/**
 * The payslip email (021 FR-005) — `bugs.md` item 8.
 *
 * Says the period and the company and nothing else about the money. A salary figure in an email
 * subject or body is visible in a notification preview on a lock screen, and in whatever log the
 * recipient's mail provider keeps; the slip itself is the attachment, which is what the client asked
 * for.
 */
export function renderPayslipEmail(input: {
  employeeName: string;
  periodLabel: string;
  companyName: string;
}): RenderedEmail {
  const { employeeName, periodLabel, companyName } = input;
  const subject = `Payslip for ${periodLabel}`;

  const text = [
    `Dear ${employeeName},`,
    '',
    `Your payslip for ${periodLabel} is attached.`,
    '',
    'This is a system generated email and does not require a reply. If anything on the',
    'payslip looks wrong, please raise it with your HR office.',
    '',
    companyName,
  ].join('\n');

  const html = [
    `<p>Dear ${escapeHtml(employeeName)},</p>`,
    `<p>Your payslip for ${escapeHtml(periodLabel)} is attached.</p>`,
    '<p>This is a system generated email and does not require a reply. If anything on the ' +
      'payslip looks wrong, please raise it with your HR office.</p>',
    `<p>${escapeHtml(companyName)}</p>`,
  ].join('\n');

  return { subject, text, html };
}

/**
 * A link to choose a new password (029 FR-010, FR-015).
 *
 * Says who asked, because the two cases call for different reactions from someone who did not
 * expect it: a self-service request they did not make is a stranger typing their address and is
 * safe to ignore, while one an administrator sent means someone at the company acted on their
 * account.
 */
export function renderPasswordResetEmail(input: {
  resetUrl: string;
  expiresAt: Date;
  requestedByAdmin: boolean;
}): RenderedEmail {
  const { resetUrl, expiresAt, requestedByAdmin } = input;
  const expiry = expiresAt.toUTCString();
  const subject = 'Reset your BuildCore password';
  const opening = requestedByAdmin
    ? 'An administrator has sent you a link to choose a new BuildCore password.'
    : 'Someone asked to reset the password for your BuildCore account.';
  const ignore = requestedByAdmin
    ? 'If you were not expecting this, contact your administrator.'
    : 'If this was not you, you can ignore this email — your password has not changed.';

  const text = [
    opening,
    '',
    'Choose a new password:',
    resetUrl,
    '',
    `This link can be used once and expires on ${expiry}.`,
    ignore,
  ].join('\n');

  const html = [
    `<p>${escapeHtml(opening)}</p>`,
    `<p><a href="${escapeHtml(resetUrl)}">Choose a new password</a></p>`,
    `<p>This link can be used once and expires on ${escapeHtml(expiry)}.</p>`,
    `<p>${escapeHtml(ignore)}</p>`,
  ].join('\n');

  return { subject, text, html };
}

/**
 * Confirms a password change after the fact (029 FR-007, FR-013).
 *
 * The point of this email is the account holder who did *not* make the change — it is how they
 * find out. So it says when, and what to do, and carries no link: a "wasn't you? click here"
 * link in a security notice is the exact shape of a phishing mail, and teaching people to click
 * one is worse than the convenience.
 */
export function renderPasswordChangedEmail(input: {
  changedAt: Date;
  via: 'self' | 'reset_link';
}): RenderedEmail {
  const when = input.changedAt.toUTCString();
  const subject = 'Your BuildCore password was changed';
  const body =
    input.via === 'reset_link'
      ? `Your BuildCore password was reset using an emailed link on ${when}. You have been signed out on every device.`
      : `Your BuildCore password was changed on ${when}. Any other devices signed in to your account have been signed out.`;
  const advice =
    'If you did not do this, contact your administrator straight away so they can secure your account.';

  return {
    subject,
    text: [body, '', advice].join('\n'),
    html: [`<p>${escapeHtml(body)}</p>`, `<p>${escapeHtml(advice)}</p>`].join(
      '\n',
    ),
  };
}

/**
 * Tells someone an administrator gave their account a temporary password (029 FR-015).
 *
 * The password itself is never in it. Email is the least protected channel the account has, and
 * the admin hands the value over in person or by phone; this message exists so the change is
 * never silent.
 */
export function renderAdminPasswordResetEmail(): RenderedEmail {
  const subject = 'Your BuildCore password was reset by an administrator';
  const body =
    'An administrator has reset your BuildCore password and signed you out on every device. They will give you a temporary password, and you will be asked to choose your own when you next sign in.';
  const advice = 'If you did not ask for this, contact your administrator.';
  return {
    subject,
    text: [body, '', advice].join('\n'),
    html: [`<p>${escapeHtml(body)}</p>`, `<p>${escapeHtml(advice)}</p>`].join(
      '\n',
    ),
  };
}

/** Tells someone their account was switched off (029 FR-030). */
export function renderAccountDeactivatedEmail(): RenderedEmail {
  const subject = 'Your BuildCore account has been deactivated';
  const body =
    'Your BuildCore account has been deactivated by an administrator, and you have been signed out. You will not be able to sign in until it is reactivated.';
  const advice =
    'If you think this is a mistake, contact your administrator or HR office.';
  return {
    subject,
    text: [body, '', advice].join('\n'),
    html: [`<p>${escapeHtml(body)}</p>`, `<p>${escapeHtml(advice)}</p>`].join(
      '\n',
    ),
  };
}

/**
 * Welcome for an account an administrator set up with a password of their choosing (029 FR-031).
 *
 * An invited account already gets its invite; this one used to get nothing. It names the sign-in
 * page and the username — and not the password, which the administrator hands over themselves.
 */
export function renderAccountReadyEmail(input: {
  loginUrl: string;
  username: string | null;
}): RenderedEmail {
  const subject = 'Your BuildCore account is ready';
  const opening = 'An administrator has created a BuildCore account for you.';
  const username = input.username
    ? `You can sign in with this email address or the username "${input.username}".`
    : 'You can sign in with this email address.';
  const password =
    'Your administrator will give you a temporary password. You will be asked to choose your own the first time you sign in.';

  const text = [
    opening,
    '',
    username,
    password,
    '',
    'Sign in:',
    input.loginUrl,
  ].join('\n');
  const html = [
    `<p>${escapeHtml(opening)}</p>`,
    `<p>${escapeHtml(username)}</p>`,
    `<p>${escapeHtml(password)}</p>`,
    `<p><a href="${escapeHtml(input.loginUrl)}">Sign in to BuildCore</a></p>`,
  ].join('\n');
  return { subject, text, html };
}
