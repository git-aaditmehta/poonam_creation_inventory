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
export function parseFriendlyError(
  err: any,
  context: { categoryName?: string; itemId?: string; defaultTitle?: string } = {}
): FriendlyError {
  const rawMsg = String(err?.message || err?.error || err || '').trim();
  const status = Number(err?.status || err?.statusCode || 0);
  const refCode = generateErrorRef();
  const rawDetails = err?.stack || JSON.stringify(err, null, 2) || rawMsg;

  // 1. Offline / Network Connectivity Loss
  if (
    !navigator.onLine ||
    rawMsg.includes('Failed to fetch') ||
    rawMsg.includes('NetworkError') ||
    rawMsg.includes('net::ERR_') ||
    rawMsg.includes('Network lost') ||
    rawMsg.includes('Load failed')
  ) {
    return {
      title: 'Working Offline — Safe & Saved',
      message: `Your changes are safely saved on this device.`,
      solution: `Once your internet connection restores, the system will automatically upload your data to the cloud. You can also click "Sync Now" anytime.`,
      isOffline: true,
      refCode,
      rawDetails,
    };
  }

  // 2. Duplicate Item ID (HTTP 409 Conflict)
  if (
    status === 409 ||
    rawMsg.toLowerCase().includes('already exists') ||
    rawMsg.toLowerCase().includes('unique constraint') ||
    rawMsg.toLowerCase().includes('duplicate')
  ) {
    const idMention = context.itemId ? `"${context.itemId}"` : 'entered';
    return {
      title: 'Item ID Already in Use',
      message: `An item with the ID ${idMention} is already saved in your ${context.categoryName || 'catalog'}.`,
      solution: `Please enter a different, unique Item ID. If you just want to update quantity, please use the "Add Stock" operation instead.`,
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

  // 4. Session / Authentication Timeout (HTTP 401 / 403)
  if (status === 401 || status === 403 || rawMsg.toLowerCase().includes('unauthorized') || rawMsg.toLowerCase().includes('authentication required')) {
    return {
      title: 'Session Expired for Security',
      message: `Your login session has timed out. Don't worry — your locally entered data on this computer is 100% safe.`,
      solution: `Please sign in again to resume syncing your changes with the cloud.`,
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

  // 6. Validation Error (Missing required fields)
  if (status === 400 || rawMsg.toLowerCase().includes('validation') || rawMsg.toLowerCase().includes('required')) {
    return {
      title: 'Please Complete Required Fields',
      message: rawMsg.replace(/^[A-Z_]+:\s*/, '') || 'Some required information is missing or formatted incorrectly.',
      solution: `Check that all fields with red indicators have numbers and valid text entered, then click Save again.`,
      refCode,
      rawDetails,
    };
  }

  // 7. Critical / Unforeseen Server Error (HTTP 500 / Cloudflare issues)
  return {
    title: 'Cloud Backup Paused',
    message: `An unexpected cloud server issue occurred during backup. Don't worry — your data is safely saved on this computer and has NOT been lost.`,
    solution: `You can continue working normally. The system will automatically retry, or you can copy the diagnostic report below and share it with your developer.`,
    isCritical: true,
    refCode,
    rawDetails,
  };
}
