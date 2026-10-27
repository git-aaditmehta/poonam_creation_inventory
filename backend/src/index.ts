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

const app = new Hono<{ Bindings: Env; Variables: { session: SessionData } }>();

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://poonam-creation-inventory.vercel.app',
  'https://poonamcreation.pages.dev',
  'https://poonamcreation.com',
  'https://www.poonamcreation.com',
];

// Strict CORS: allow localhost, Vercel frontend, production domain, and preview branches
app.use('/api/*', cors({
  origin: (origin) => {
    if (!origin) return '';
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    if (/^https:\/\/poonam-creation-inventory(-[a-z0-9_-]+)?\.vercel\.app$/.test(origin)) {
      return origin;
    }
    if (/^https:\/\/[a-z0-9-]+\.poonamcreation\.pages\.dev$/.test(origin)) {
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

// Catch-all 404
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err.message);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
