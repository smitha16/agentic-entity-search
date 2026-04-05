// Search API route. Provides the SSE streaming endpoint POST /stream that
// validates the request payload, runs the search pipeline, and sends per-step
// progress events followed by the final structured entity results.

import { Router } from 'express';
import { z } from 'zod';

import { runSearchPipelineWithEvents } from '../services/searchPipeline.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();

const requestSchema = z.object({
  topic: z.string().trim().min(3),
  maxEntities: z.number().int().min(1).max(25).optional(),
  entityType: z.string().trim().min(2).max(50).optional()
});

// SSE streaming endpoint. Sends per-step progress events and a final result
// event over a Server-Sent Events connection.
router.post('/stream', async (req, res, next) => {
  // Validate input
  let payload;
  try {
    payload = requestSchema.parse(req.body);
  } catch (error) {
    if (error.name === 'ZodError') {
      next(new HttpError(400, 'Invalid request payload'));
      return;
    }
    next(error);
    return;
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  // Writes a pipeline step event to the SSE stream.
  function emitStep(step, detail = {}) {
    if (res.writableEnded) return;
    const event = JSON.stringify({ type: 'step', step, ...detail });
    res.write(`data: ${event}\n\n`);
  }

  // Send periodic keepalive comments to prevent connection timeout.
  const keepalive = setInterval(() => {
    if (res.writableEnded) { clearInterval(keepalive); return; }
    res.write(': keepalive\n\n');
  }, 15000);

  // Clean up the keepalive interval if the client disconnects.
  req.on('close', () => clearInterval(keepalive));

  // Run the pipeline and stream results.
  try {
    const result = await runSearchPipelineWithEvents(payload, emitStep);

    // Send the final result as the last SSE event.
    clearInterval(keepalive);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    clearInterval(keepalive);
    // If headers already sent, write error as SSE event
    // (can't use normal Express error handling once streaming starts)
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        res.end();
      }
    } else {
      next(error);
    }
  }
});

// Express router with the SSE streaming search endpoint.
export const searchRouter = router;