/**
 * Agreed rule: only stock in/out works offline. Adding, editing or deleting items, photo uploads and
 * Excel import need internet, and say so honestly instead of pretending to "save locally".
 */
type ShowToast = (type: 'success' | 'error' | 'warning' | 'info', title: string, message?: string) => void;

export const OFFLINE_TITLE = "You're offline";
export const OFFLINE_MESSAGE = 'This needs internet. Stock in/out still works offline.';

/** Returns true (and explains) when the device is offline, so the caller stops. */
export function blockIfOffline(showToast: ShowToast, what = 'This'): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    showToast('warning', OFFLINE_TITLE, `${what} needs internet. Stock in/out still works offline.`);
    return true;
  }
  return false;
}
