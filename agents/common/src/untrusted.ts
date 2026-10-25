/**
 * Fencing for text revuto did not write: PR titles, bodies, branch and file
 * names, comments, learned candidates. The fence uses a fresh random nonce, so
 * the text cannot contain or forge its closing marker.
 */
import { randomBytes } from 'node:crypto';

export interface Fence { readonly open: string; readonly close: string; readonly body: string }

export function fenceUntrusted(text: string): Fence {
  const nonce = randomBytes(12).toString('hex');
  return { open: `<<<UNTRUSTED-${nonce}>>>`, close: `<<<END-UNTRUSTED-${nonce}>>>`, body: text };
}

/** Control characters (other than newline and tab) can hide or reorder text; they are dropped. */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
}
