/**
 * Message bodies, defined as constants rather than inline in the adapters
 * (Constitution Principle III) so wording can change without touching delivery code,
 * and so both adapters render identically.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  /** The body only — `renderEmailLayout` puts the letterhead and footer around it. */
  html: string;
}

/**
 * The name every email signs with (2026-10-24). The client's group, not the product: the people
 * receiving these work for Tirupati Enterprises or Parth Realcon and have never heard of BuildCore.
 */
export const EMAIL_BRAND_NAME = 'Tirupati Groups';

/** The navy both company logos are drawn in, so the button and rule sit with either mark. */
const BRAND_COLOUR = '#31526e';

/** The inline attachment the layout's `<img>` points at. */
export const LOGO_CONTENT_ID = 'company-logo';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * "24 Oct 2026, 2:30 pm IST" in the business timezone. Every recipient is in India, and a link
 * that "expires on Sat, 24 Oct 2026 09:00:00 GMT" made them do the arithmetic.
 */
function formatWhen(date: Date, timeZone: string): string {
  const when = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  const zone =
    new Intl.DateTimeFormat('en-IN', { timeZone, timeZoneName: 'short' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
  return `${when} ${zone}`;
}

/**
 * A link drawn as a button, with the address underneath for mail clients that strip styling —
 * and for anyone who would rather read where a link goes before clicking it.
 */
function buttonHtml(url: string, label: string): string {
  const href = escapeHtml(url);
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">',
    `<tr><td style="background:${BRAND_COLOUR};border-radius:6px;">`,
    `<a href="${href}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(
      label,
    )}</a>`,
    '</td></tr></table>',
    `<p style="font-size:13px;color:#6b7785;">If the button does not work, copy this link into your browser:<br><a href="${href}" style="color:${BRAND_COLOUR};word-break:break-all;">${href}</a></p>`,
  ].join('\n');
}

/**
 * Whose email this is: the recipient's company, so a Parth Realcon employee sees Parth Realcon's
 * logo and a Tirupati Enterprises employee sees Tirupati's (2026-10-24).
 */
export interface EmailBrand {
  /** Null for an account with no home company — the group name stands in. */
  companyName: string | null;
  /** True when the company's logo is attached inline under `LOGO_CONTENT_ID`. */
  hasLogo: boolean;
}

/**
 * Wraps a body in the letterhead and footer. Tables and inline styles throughout, because that is
 * all Outlook and Gmail reliably keep.
 */
export function renderEmailLayout(bodyHtml: string, brand: EmailBrand): string {
  const name = escapeHtml(brand.companyName ?? EMAIL_BRAND_NAME);
  const header = brand.hasLogo
    ? `<img src="cid:${LOGO_CONTENT_ID}" alt="${name}" height="48" style="display:block;height:48px;width:auto;max-width:240px;border:0;">`
    : `<div style="font-size:20px;font-weight:700;color:${BRAND_COLOUR};">${name}</div>`;
  const font =
    "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>',
    `<body style="margin:0;padding:0;background:#f4f6f8;${font}">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px;">',
    '<tr><td align="center">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;border-top:4px solid ${BRAND_COLOUR};">`,
    `<tr><td style="padding:28px 32px 8px;">${header}</td></tr>`,
    `<tr><td style="padding:8px 32px 24px;font-size:15px;line-height:1.6;color:#1f2933;${font}">`,
    bodyHtml,
    '</td></tr>',
    `<tr><td style="padding:16px 32px 24px;border-top:1px solid #e5e9ee;font-size:12px;line-height:1.5;color:#6b7785;${font}">`,
    `This is an automated email from ${name}. Please do not reply to it.`,
    // The group signs under a company's name; with no company it already is the name above.
    brand.companyName ? `<br>${escapeHtml(EMAIL_BRAND_NAME)}` : '',
    '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('\n');
}

/** Rendering settings every template that prints a time needs. */
export interface RenderOptions {
  /** IANA zone (`settings.timezone`) the times are written in. */
  timeZone: string;
}

export function renderInviteEmail(
  input: {
    setPasswordUrl: string;
    isResend: boolean;
    expiresAt: Date;
  },
  options: RenderOptions,
): RenderedEmail {
  const { setPasswordUrl, isResend, expiresAt } = input;
  const expiry = formatWhen(expiresAt, options.timeZone);
  const subject = isResend
    ? `Your new ${EMAIL_BRAND_NAME} invite link`
    : `Set up your ${EMAIL_BRAND_NAME} account`;

  // A resend says so explicitly. Someone who already clicked a dead link needs to
  // know this one replaces it, rather than wondering which of two mails is current.
  const opening = isResend
    ? `Here is a new link to set up your ${EMAIL_BRAND_NAME} account. Any earlier link no longer works.`
    : `An administrator has created a ${EMAIL_BRAND_NAME} account for you.`;

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
    buttonHtml(setPasswordUrl, 'Set your password'),
    `<p>This link can be used once and expires on ${escapeHtml(expiry)}.</p>`,
    '<p>If you were not expecting this, you can ignore this email.</p>',
  ].join('\n');

  return { subject, text, html };
}

export function renderAccountLockedEmail(
  input: {
    unlockAt: Date;
  },
  options: RenderOptions,
): RenderedEmail {
  const unlock = formatWhen(input.unlockAt, options.timeZone);
  const subject = `Your ${EMAIL_BRAND_NAME} account is temporarily locked`;
  const body = `Your ${EMAIL_BRAND_NAME} account was locked after several failed sign-in attempts.`;

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
export function renderPasswordResetEmail(
  input: {
    resetUrl: string;
    expiresAt: Date;
    requestedByAdmin: boolean;
  },
  options: RenderOptions,
): RenderedEmail {
  const { resetUrl, expiresAt, requestedByAdmin } = input;
  const expiry = formatWhen(expiresAt, options.timeZone);
  const subject = `Reset your ${EMAIL_BRAND_NAME} password`;
  const opening = requestedByAdmin
    ? `An administrator has sent you a link to choose a new ${EMAIL_BRAND_NAME} password.`
    : `Someone asked to reset the password for your ${EMAIL_BRAND_NAME} account.`;
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
    buttonHtml(resetUrl, 'Choose a new password'),
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
export function renderPasswordChangedEmail(
  input: {
    changedAt: Date;
    via: 'self' | 'reset_link';
  },
  options: RenderOptions,
): RenderedEmail {
  const when = formatWhen(input.changedAt, options.timeZone);
  const subject = `Your ${EMAIL_BRAND_NAME} password was changed`;
  const body =
    input.via === 'reset_link'
      ? `Your ${EMAIL_BRAND_NAME} password was reset using an emailed link on ${when}. You have been signed out on every device.`
      : `Your ${EMAIL_BRAND_NAME} password was changed on ${when}. Any other devices signed in to your account have been signed out.`;
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
  const subject = `Your ${EMAIL_BRAND_NAME} password was reset by an administrator`;
  const body = `An administrator has reset your ${EMAIL_BRAND_NAME} password and signed you out on every device. They will give you a temporary password, and you will be asked to choose your own when you next sign in.`;
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
  const subject = `Your ${EMAIL_BRAND_NAME} account has been deactivated`;
  const body = `Your ${EMAIL_BRAND_NAME} account has been deactivated by an administrator, and you have been signed out. You will not be able to sign in until it is reactivated.`;
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
  const subject = `Your ${EMAIL_BRAND_NAME} account is ready`;
  const opening = `An administrator has created a ${EMAIL_BRAND_NAME} account for you.`;
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
    buttonHtml(input.loginUrl, 'Sign in'),
  ].join('\n');
  return { subject, text, html };
}
