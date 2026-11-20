/**
 * Cloudflare Pages Function: forwards every /api/* request to the server (Worker "poonam-creation-backend") over
 * Cloudflare's internal service binding "API" (wrangler.toml). Agreed 2026-11-20:
 *   - same address for the page and the API (no CORS, no third-party proxy hop)
 *   - phones never call *.workers.dev (served from abroad on Indian networks; the Pages site is served from Mumbai)
 *   - the caller's real IP reaches the server (login attempt limits work per device)
 * Only /api/* runs this function (public/_routes.json); page files are served directly, free and unlimited.
 */
interface Env {
  API: { fetch: (request: Request) => Promise<Response> };
}

export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> => {
  try {
    return await context.env.API.fetch(context.request);
  } catch (err) {
    console.error('[forwarder] server unreachable:', err);
    return new Response(
      JSON.stringify({ error: 'The server could not be reached. Please try again in a moment.', code: 'server_unreachable' }),
      { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    );
  }
};
