import { contentDispositionFor } from '../storage/file-type';
import { renderFormDocx } from './form-docx.renderer';
import type { FormDocument } from './form-document.types';
import { renderFormPdf } from './form-pdf.renderer';
import { renderFormWorkbook } from './form-xlsx.renderer';

export * from './form-document.types';
export * from './form-format';
export { renderFormDocx, renderFormPdf, renderFormWorkbook };

export type FormFormat = 'pdf' | 'xlsx' | 'docx';

export const FORM_CONTENT_TYPES: Record<FormFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function isFormFormat(value: string): value is FormFormat {
  return value === 'pdf' || value === 'xlsx' || value === 'docx';
}

/** One document, drawn in the format asked for. */
export function renderForm(
  form: FormDocument,
  format: FormFormat,
): Promise<Buffer> {
  if (format === 'xlsx') return renderFormWorkbook(form);
  if (format === 'docx') return renderFormDocx(form);
  return renderFormPdf(form);
}

/** A rendered document as a controller sends it. */
export interface RenderedForm {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export async function renderFormFile(
  form: FormDocument,
  format: FormFormat,
  stem: string,
): Promise<RenderedForm> {
  return {
    bytes: await renderForm(form, format),
    contentType: FORM_CONTENT_TYPES[format],
    filename: `${stem}.${format}`,
  };
}

/**
 * Sends a rendered document as an attachment. `Content-Disposition` is exposed to the browser
 * in `main.ts`, so the web saves it under this name.
 */
export function sendForm(
  res: {
    setHeader(name: string, value: string): unknown;
    send(body: Buffer): unknown;
  },
  rendered: RenderedForm,
): void {
  res.setHeader('Content-Type', rendered.contentType);
  // Names here are not ASCII — "Whitefield Tech Park — Phase II" — and a raw one in the header
  // is a 500; the shared builder sends an ASCII stand-in and the real name as `filename*`.
  res.setHeader(
    'Content-Disposition',
    contentDispositionFor(rendered.filename),
  );
  res.send(rendered.bytes);
}

/** The `:format` of a document route, or a 400-worthy null. */
export function formFormatOf(
  value: string,
  allowed: FormFormat[] = ['pdf', 'xlsx'],
): FormFormat | null {
  return isFormFormat(value) && allowed.includes(value) ? value : null;
}
