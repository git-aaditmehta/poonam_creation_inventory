/**
 * Registers the service worker (production builds only) and keeps the installed app (PWA) up to date.
 *
 * How a new version reaches a phone (agreed 2026-11-21, after the client's installed app stayed on an old version):
 *  - The app looks for a new version when it opens, when it comes back to the screen, and every 30 minutes while open.
 *  - A new version downloads in the background. When it is ready the app shows "A new version is ready — tap to
 *    update"; nobody is switched mid-work.
 *  - If a downloaded version is waiting when the app is OPENED, it is switched to straight away, as long as nobody
 *    has tapped or typed yet (first few seconds), so a phone that is simply reopened gets the latest version.
 *  - Backup & Storage and the side menu show the version number and a "Check for updates" button.
 */

declare const __APP_VERSION__: AppVersion;

export interface AppVersion {
  /** Number of commits on main when built (#48, #49 …); null if it could not be counted. */
  number: number | null;
  commit: string;
  built: string;
}

/** The version of the app running on this phone. */
export const APP_VERSION: AppVersion =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : { number: null, commit: 'dev', built: new Date().toISOString() };

export function versionLabel(v: AppVersion = APP_VERSION): string {
  return v.number ? `#${v.number}` : v.commit;
}

const CHECK_EVERY_MS = 30 * 60 * 1000;
/** A downloaded update found within this time after opening the app is applied straight away. */
const STARTUP_WINDOW_MS = 8000;
const startedAt = Date.now();
/** Set at the first tap or key press: from then on an update never switches in by itself (it could wipe typing). */
let userActed = false;
if (typeof window !== 'undefined') {
  const acted = () => {
    userActed = true;
  };
  window.addEventListener('pointerdown', acted, { once: true, capture: true });
  window.addEventListener('keydown', acted, { once: true, capture: true });
}
const justOpened = () => !userActed && Date.now() - startedAt < STARTUP_WINDOW_MS;

let registration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;

function announce(worker: ServiceWorker) {
  waitingWorker = worker;
  window.dispatchEvent(new CustomEvent('app-update-available'));
}

/** True while an update is downloaded and waiting to be switched to. */
export function isUpdateReady(): boolean {
  return waitingWorker !== null;
}

function watchInstalling(reg: ServiceWorkerRegistration) {
  const nw = reg.installing;
  if (!nw) return;
  nw.addEventListener('statechange', () => {
    // "installed" while another version controls the page = an update (not the very first install)
    if (nw.state === 'installed' && navigator.serviceWorker.controller) {
      if (justOpened()) nw.postMessage({ type: 'SKIP_WAITING' }); // app just opened, nothing touched yet
      else announce(nw);
    }
  });
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) {
        // A version downloaded earlier is waiting and the app was just opened: switch now, before any work starts
        if (justOpened()) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        else announce(reg.waiting);
      }
      if (reg.installing) watchInstalling(reg);
      reg.addEventListener('updatefound', () => watchInstalling(reg));
      // Look for a new version whenever the app is brought back to the screen, and regularly while it is open
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => undefined);
      });
      setInterval(() => {
        if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => undefined);
      }, CHECK_EVERY_MS);
    } catch (e) {
      console.warn('[SW] Registration failed (the app still works online):', e);
    }
  });

  let reloading = false;
  // The very first install also "changes the controller" (none -> first version): no reload then, or a login being
  // typed on the first visit would be wiped. Only a switch from one version to another reloads.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

/** Switch to the downloaded version now (reloads the page). */
export function applyAppUpdate(): void {
  if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
}

export type UpdateCheck =
  | { state: 'latest'; latest: AppVersion }
  | { state: 'ready'; latest: AppVersion | null }
  | { state: 'downloading'; latest: AppVersion }
  | { state: 'offline' }
  | { state: 'unavailable' }
  | { state: 'error' };

/** The version on the site right now (never from a cache). */
async function fetchLatestVersion(): Promise<AppVersion> {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`version.json ${res.status}`);
  return (await res.json()) as AppVersion;
}

/**
 * "Check for updates": compares this phone's version with the site's and starts the download if needed.
 * 'downloading' then turns into the "ready" banner (app-update-available) when the download finishes.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!navigator.onLine) return { state: 'offline' };
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return { state: 'unavailable' };
  try {
    const latest = await fetchLatestVersion();
    if (waitingWorker) return { state: 'ready', latest };
    const same = latest.commit === APP_VERSION.commit;
    if (same) return { state: 'latest', latest };
    const reg = registration || (await navigator.serviceWorker.getRegistration());
    if (!reg) return { state: 'error' };
    await reg.update();
    if (reg.waiting && navigator.serviceWorker.controller) {
      announce(reg.waiting);
      return { state: 'ready', latest };
    }
    return { state: 'downloading', latest };
  } catch {
    return navigator.onLine ? { state: 'error' } : { state: 'offline' };
  }
}
