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
