import { Router } from 'express';
import { z } from 'zod';

import { runSearchPipeline } from '../services/searchPipeline.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();

const requestSchema = z.object({
  topic: z.string().trim().min(3),
  maxEntities: z.number().int().min(1).max(25).optional(),
  entityType: z.string().trim().min(2).max(50).optional()
});

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

export const searchRouter = router;
