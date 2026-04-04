// server/routes/search.js

import { Router } from 'express';
import { z } from 'zod';

import { runSearchPipeline, runSearchPipelineWithEvents } from '../services/searchPipeline.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();

const requestSchema = z.object({
  topic: z.string().trim().min(3),
  maxEntities: z.number().int().min(1).max(25).optional(),
  entityType: z.string().trim().min(2).max(50).optional()
});

// ─── Existing route (keep it, still works) ───

router.post('/', async (req, res, next) => {
  try {
    const payload = requestSchema.parse(req.body);
    const result = await runSearchPipeline(payload);
    res.json(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      next(new HttpError(400, 'Invalid request payload'));
      return;
    }
    next(error);
  }
});

// ─── NEW: SSE streaming route ───

router.post('/stream', async (req, res, next) => {
  // 1. Validate input (same as above)
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

  // 2. Set up SSE headers — tells the browser "this is a stream"
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  // 3. Define what emit() does — it writes to the stream
  //    THIS is the function that gets passed into the pipeline
  function emitStep(step, detail = {}) {
    if (res.writableEnded) return;
    const event = JSON.stringify({ type: 'step', step, ...detail });
    res.write(`data: ${event}\n\n`);
  }

  // 3b. Keep the connection alive during long LLM waits
  const keepalive = setInterval(() => {
    if (res.writableEnded) { clearInterval(keepalive); return; }
    res.write(': keepalive\n\n');
  }, 15000);

  // 3c. Clean up if the client disconnects
  req.on('close', () => clearInterval(keepalive));

  // 4. Run the pipeline, passing emitStep as the callback
  try {
    const result = await runSearchPipelineWithEvents(payload, emitStep);

    // 5. Send the final result as the last event
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

export const searchRouter = router;