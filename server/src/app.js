// Express application factory. Configures CORS, JSON body parsing, health
// check endpoint, search API routes, and a global error handler.

import cors from 'cors';
import express from 'express';

import { searchRouter } from './routes/search.js';

// Creates and configures the Express application with middleware and routes.
export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/search', searchRouter);

  app.use((error, _req, res, _next) => {
    const status = error.statusCode || 500;
    res.status(status).json({
      error: error.message || 'Unexpected server error'
    });
  });

  return app;
}
