/**
 * Registers the service worker (production builds only) and keeps the installed app (PWA) up to date.
 *
 * How a new version reaches a phone (agreed 2026-11-21, after the client's installed app stayed on an old version):
 *  - The app looks for a new version when it opens and when it comes back to the screen (no timers).
 *  - A new version downloads in the background. When it is ready, a bar at the top says "New update available";
 *    tapping it (or "Update now" in Backup & Storage / the side menu) switches to it. Nobody is switched by surprise.
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
    if (nw.state === 'installed' && navigator.serviceWorker.controller) announce(nw);
  });
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      registration = reg;
      // A version downloaded earlier is still waiting: show the bar again
      if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
      if (reg.installing) watchInstalling(reg);
      reg.addEventListener('updatefound', () => watchInstalling(reg));
      // Look for a new version whenever the app is brought back to the screen
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => undefined);
      });
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

const UPDATED_FLAG = 'app-updated-from';

/** After an update reload: the version it came from (once), so the app can say "Updated to version #NN". */
export function takeUpdatedFrom(): string | null {
  try {
    const from = sessionStorage.getItem(UPDATED_FLAG);
    sessionStorage.removeItem(UPDATED_FLAG);
    return from && from !== APP_VERSION.commit ? from : null;
  } catch {
    return null;
  }
}

/** Switch to the downloaded version now (reloads the page). */
export function applyAppUpdate(): void {
  try {
    sessionStorage.setItem(UPDATED_FLAG, APP_VERSION.commit);
  } catch {
    /* private mode: no message after the reload, the update still happens */
  }
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
