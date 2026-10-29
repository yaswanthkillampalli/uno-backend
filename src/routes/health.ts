import { Router } from 'express';
import { isProd } from '../config/env.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../utils/logger.js';

export const healthRouter = Router();

// Is the process up?
healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

// Can we reach Supabase with our secret key, and does the schema exist?
healthRouter.get('/health/db', async (_req, res) => {
  const { error } = await supabase.from('rooms').select('id', { count: 'exact', head: true });

  if (error) {
    logger.error('Supabase health check failed', error);
    res.status(503).json({
      status: 'error',
      db: 'unavailable',
      ...(isProd ? {} : { code: error.code, message: error.message }),
    });
    return;
  }

  res.json({ status: 'ok', db: 'ok' });
});