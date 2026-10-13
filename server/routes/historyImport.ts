import historicalDataImport from '@server/lib/historicalDataImport';
import { HistoricalImportConflictError } from '@server/lib/historicalDataInspection';
import { Permission } from '@server/lib/permissions';
import { isAuthenticated } from '@server/middleware/auth';
import { Router, raw } from 'express';

const router = Router();
router.use(isAuthenticated(Permission.ADMIN));
const historyBody = raw({ type: 'application/octet-stream', limit: '16mb' });

const parseBody = (body: unknown): unknown => {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new Error('Historical data file is required');
  }
  return JSON.parse(body.toString('utf8'));
};

router.get('/', async (_req, res, next) => {
  try {
    return res.status(200).json({
      supportedSchemas: ['wholphin-history-v1'],
      maximumFileBytes: 16 * 1024 * 1024,
      status: await historicalDataImport.status(),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/validate', historyBody, async (req, res, next) => {
  try {
    return res
      .status(200)
      .json(await historicalDataImport.inspect(parseBody(req.body)));
  } catch (error) {
    return next(error);
  }
});

router.post('/', historyBody, async (req, res, next) => {
  try {
    return res
      .status(200)
      .json(await historicalDataImport.import(parseBody(req.body)));
  } catch (error) {
    if (error instanceof HistoricalImportConflictError) {
      return res.status(409).json({
        message: error.message,
        inspection: error.inspection,
      });
    }
    return next(error);
  }
});

export default router;
