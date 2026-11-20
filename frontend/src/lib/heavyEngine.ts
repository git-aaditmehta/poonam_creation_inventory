/**
 * One heavy engine at a time (agreed 2026-11-20).
 *
 * The scanner model (~270 MB in the browser) and the "Read ID from photo" engine (~170 MB) must never be loaded
 * together: on a 3-4 GB Android phone ~450 MB in one tab risks the browser closing the app. Every use of either
 * engine runs through this queue, so they take turns. The ID reader unloads the scanner model before it starts and
 * closes itself when its batch is done; scanner learning then waits for that.
 */
let chain: Promise<unknown> = Promise.resolve();

export function withHeavyEngine<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task);
  chain = run.catch(() => undefined);
  return run;
}
