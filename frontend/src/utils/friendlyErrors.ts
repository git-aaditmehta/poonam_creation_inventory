import { cloudLimitResetText } from './time';
/**
 * friendlyErrors.ts
 *
 * Translates technical error messages, HTTP status codes, and exceptions
 * into clear, reassuring, and actionable plain-English explanations for non-technical users.
 *
 * Follows the 3-Part Human Rule:
 * 1. What happened (Plain English)
 * 2. Why it happened (Context)
 * 3. What to do next (Actionable solution or Developer Diagnostic Report)
 */

export interface FriendlyError {
  title: string;
  message: string;
  solution: string;
  isOffline?: boolean;
  isDuplicate?: boolean;
  isCritical?: boolean;
  refCode?: string;
  rawDetails?: string;
}

/**
 * Generate a short 6-character diagnostic reference code (e.g. ERR-A79B2C)
 */
export function generateErrorRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'ERR-';
  for (let i = 0; i < 6; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ref;
}

/**
 * Format a comprehensive, copyable diagnostic report for the developer.
 */
export function createDiagnosticReport(
  error: FriendlyError,
  context: { action?: string; category?: string; itemId?: string }
): string {
  const now = new Date();
  return [
    '========================================',
    'POONAM CREATION — DIAGNOSTIC ERROR REPORT',
    '========================================',
    `Reference Code : ${error.refCode || 'N/A'}`,
    `Timestamp      : ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (${now.toISOString()})`,
    `Action         : ${context.action || 'Unknown Operation'}`,
    `Category       : ${context.category || 'N/A'}`,
    `Item ID        : ${context.itemId || 'N/A'}`,
    `User Title     : ${error.title}`,
    `User Message   : ${error.message}`,
    `Recommended Fix: ${error.solution}`,
    '----------------------------------------',
    'TECHNICAL DETAILS FOR DEVELOPER:',
    error.rawDetails || 'No additional raw stack/payload captured',
    '----------------------------------------',
    `Browser/Device : ${typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown'}`,
    `Online Status  : ${typeof navigator !== 'undefined' ? (navigator.onLine ? 'Online' : 'Offline') : 'Unknown'}`,
    '========================================',
  ].join('\n');
}

/**
 * Translate any error object, HTTP response, or exception string into a FriendlyError.
 */
/** The cloud's free daily read/write limit is used up (server answers code "daily_limit"). */
export function isDailyLimitError(err: any): boolean {
  return err?.data?.code === 'daily_limit' || err?.code === 'daily_limit';
}

export function dailyLimitMessage(err: any): string {
  const kind = err?.data?.kind;
  const what = kind === 'read' ? 'reading data' : kind === 'requests' ? 'requests' : 'saving changes';
  return `The cloud's free daily limit for ${what} has been reached. It renews ${cloudLimitResetText()}.`;
}

export function parseFriendlyError(
  err: any,
  context: { categoryName?: string; itemId?: string; defaultTitle?: string } = {}
): FriendlyError {
  const rawMsg = String(err?.message || err?.error || err || '').trim();
  const status = Number(err?.status || err?.statusCode || 0);
  const refCode = generateErrorRef();
  const rawDetails = err?.stack || JSON.stringify(err, null, 2) || rawMsg;

  // 0. The cloud's free daily limit is used up: say so and when it renews
  if (isDailyLimitError(err)) {
    return {
      title: 'Cloud daily limit reached',
      message: `${context.itemId ? `"${context.itemId}" was not saved. ` : ''}${dailyLimitMessage(err)}`,
      solution: 'Nothing already saved is lost. Stock in/out and Costing changes stay on this phone and upload automatically after the renewal; other changes can be made again then.',
      refCode,
      rawDetails,
    };
  }

  // 1. No internet. Adding, editing or deleting items and photo uploads only work online (agreed rule):
  //    nothing was saved, and the message must say so — never "saved on this device".
  if (
    !navigator.onLine ||
    rawMsg.includes('Failed to fetch') ||
    rawMsg.includes('NetworkError') ||
    rawMsg.includes('net::ERR_') ||
    rawMsg.includes('Network lost') ||
    rawMsg.includes('Load failed')
  ) {
    return {
      title: 'No internet connection',
      message: `${context.itemId ? `"${context.itemId}"` : 'This change'} was not saved: this needs internet.`,
      solution: 'Connect to the internet and try again. Stock in/out still works offline.',
      isOffline: true,
      refCode,
      rawDetails,
    };
  }

  // 2. Duplicate Item ID (HTTP 409 Conflict). The server's message names the existing item
  //    (IDs that differ only in capitals, spaces or dashes are the same item).
  if (
    status === 409 ||
    rawMsg.toLowerCase().includes('already exists') ||
    rawMsg.toLowerCase().includes('unique constraint') ||
    rawMsg.toLowerCase().includes('duplicate')
  ) {
    const idMention = context.itemId ? `"${context.itemId}"` : 'This ID';
    return {
      title: 'Item ID already in use',
      message: rawMsg.toLowerCase().includes('already exists')
        ? rawMsg
        : `${idMention} is already used in ${context.categoryName || 'this category'}. IDs that differ only in capitals, spaces or dashes are the same item.`,
      solution: 'Use a different Item ID. To change the quantity of the existing item, use Stock Operations.',
      isDuplicate: true,
      refCode,
      rawDetails,
    };
  }

  // 3. Insufficient Stock (Negative Inventory Barrier)
  if (rawMsg.toLowerCase().includes('insufficient stock') || status === 400 && rawMsg.includes('stock')) {
    return {
      title: 'Insufficient Stock Available',
      message: `You cannot subtract more items than what currently exists in stock.`,
      solution: `Please check the available balance on screen and enter a quantity equal to or less than the current stock.`,
      refCode,
      rawDetails,
    };
  }

  // 4. Login no longer valid (HTTP 401 / 403)
  if (status === 401 || status === 403 || rawMsg.toLowerCase().includes('unauthorized') || rawMsg.toLowerCase().includes('authentication required')) {
    return {
      title: status === 403 ? 'Not allowed' : 'Please sign in again',
      message: status === 403
        ? 'Your account is not allowed to do this. Only the owner can add, edit or delete items.'
        : 'Your login is no longer valid, so this change was not saved.',
      solution: status === 403
        ? 'Ask the owner to make this change.'
        : 'Sign in again. Stock changes waiting on this phone are kept and sent after you sign in.',
      refCode,
      rawDetails,
    };
  }

  // 5. Image Size or Format Error
  if (rawMsg.toLowerCase().includes('image') && (rawMsg.includes('format') || rawMsg.includes('5mb') || rawMsg.includes('unsupported'))) {
    return {
      title: 'Image Format or Size Issue',
      message: `The photo selected could not be uploaded.`,
      solution: `Please use standard photo formats (JPG, PNG, WebP) under 5 MB. If the photo was taken on iPhone (HEIC), please save it as JPG first.`,
      refCode,
      rawDetails,
    };
  }

  // 6. The entry was refused (missing field, decimal where only whole numbers are allowed, …): show the
  //    server's own reason in plain words
  if (status === 400 || rawMsg.toLowerCase().includes('validation') || rawMsg.toLowerCase().includes('required')) {
    const readable = humanizeFieldNames(rawMsg.replace(/^[A-Z_]+:\s*/, ''));
    return {
      title: 'Please check the entry',
      message: readable || 'Some information is missing or not in the right format.',
      solution: 'Correct the highlighted field and save again. Nothing was saved.',
      refCode,
      rawDetails,
    };
  }

  // 7. Unexpected server problem: say plainly that nothing was saved (no false "saved on this computer")
  return {
    title: 'Server problem — not saved',
    message: `${context.itemId ? `"${context.itemId}"` : 'This change'} was not saved because of a server problem.`,
    solution: 'Please try again in a moment. If it keeps happening, copy the report below and send it to your developer.',
    isCritical: true,
    refCode,
    rawDetails,
  };
}

/** Server messages name fields technically ("low_stock_threshold must be …"): make them readable. */
function humanizeFieldNames(msg: string): string {
  return msg
    .replace(/\blow_stock_threshold\b/g, 'Low stock threshold')
    .replace(/\bcost_price\b/g, 'Cost price')
    .replace(/\bitem_id\b/g, 'Item ID')
    .replace(/\bquantity\b/g, 'Quantity')
    .replace(/\bunit\b/g, 'Unit');
}

/**
 * One plain sentence for any error, for short messages (toasts): never "Failed to fetch" or a code.
 * Used where an action failed and the person needs to know why and what to do.
 */
export function errorText(err: any): string {
  const raw = String(err?.message || err?.error || err || '').trim();
  const status = Number(err?.status || 0);
  if (isDailyLimitError(err)) return dailyLimitMessage(err);
  if (
    (typeof navigator !== 'undefined' && !navigator.onLine) ||
    /Failed to fetch|NetworkError|net::ERR_|Load failed|Network lost/i.test(raw)
  ) {
    return 'No internet connection. Connect and try again.';
  }
  if (status === 401) return 'Your login is no longer valid. Please sign in again.';
  if (status === 403) return 'Only the owner can do this.';
  if (status >= 500) return 'Server problem. Please try again in a moment.';
  return humanizeFieldNames(raw) || 'Something went wrong. Please try again.';
}
