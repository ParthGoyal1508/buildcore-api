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
