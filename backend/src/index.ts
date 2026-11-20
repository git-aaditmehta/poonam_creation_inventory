import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, SessionData } from './types';
import auth from './routes/auth';
import inventory from './routes/inventory';
import stock from './routes/stock';
import history from './routes/history';
import images from './routes/images';
import backup from './routes/backup';
import excel from './routes/excel';
import sync from './routes/sync';
import visualSearch from './routes/visual-search';
import visualSearchDino from './routes/visual-search-dino';
import costing from './routes/costing';
import { dailyLimitKind, dailyLimitBody } from './utils/limits';

const app = new Hono<{ Bindings: Env; Variables: { session: SessionData } }>();

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://poonam-creation-inventory.pages.dev',
  'https://poonam-creation-inventory.vercel.app', // old host: remove once Vercel is stopped
];

// Strict CORS: localhost, the Cloudflare Pages site (+ its preview addresses), and the old Vercel site.
// The live app calls its own site (Pages forwards /api internally), so these only matter for cross-site calls.
app.use('/api/*', cors({
  origin: (origin) => {
    if (!origin) return '';
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    if (/^https:\/\/[a-z0-9-]+\.poonam-creation-inventory\.pages\.dev$/.test(origin)) return origin; // preview deploys
    if (/^https:\/\/poonam-creation-inventory(-[a-z0-9_-]+)?\.vercel\.app$/.test(origin)) {
      return origin;
    }
    return '';
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Mount routes
app.route('/api/auth', auth);
app.route('/api/inventory', inventory);
app.route('/api/stock', stock);
app.route('/api/history', history);
app.route('/api/images', images);
app.route('/api/backup', backup);
app.route('/api/excel', excel);
app.route('/api/sync', sync);
app.route('/api/visual-search', visualSearch);
app.route('/api/visual-search-dino', visualSearchDino);
app.route('/api/costing', costing);

// Catch-all 404
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Global error handler
app.onError((err, c) => {
  // Free plan daily read/write limit used up: a clear answer the app understands (and queues wait instead of failing)
  const limit = dailyLimitKind(err);
  if (limit) {
    console.warn(`[limits] D1 daily ${limit} limit reached`);
    return c.json(dailyLimitBody(limit), 503);
  }
  console.error('Unhandled error:', err.message);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
