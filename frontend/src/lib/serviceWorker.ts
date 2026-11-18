/**
 * Registers the service worker (production builds only) and reports when a new app version is ready.
 * A new version never switches in by itself mid-work: the app shows "Update available" and calls
 * applyAppUpdate() when the user taps it.
 */
let waitingWorker: ServiceWorker | null = null;

function announce(worker: ServiceWorker) {
  waitingWorker = worker;
  window.dispatchEvent(new CustomEvent('app-update-available'));
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // "installed" while another version controls the page = an update (not the very first install)
          if (nw.state === 'installed' && navigator.serviceWorker.controller) announce(nw);
        });
      });
      // Look for a new version whenever the app is brought back to the screen
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => undefined);
      });
    } catch (e) {
      console.warn('[SW] Registration failed (the app still works online):', e);
    }
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
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
