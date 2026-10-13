import removalScheduler from '@server/lib/removalScheduler';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

export type RemovalJobKey = 'scan' | 'processing';

export const removalJobEnabled = (key: RemovalJobKey) =>
  key === 'scan'
    ? getSettings().removal.removalScanEnabled
    : getSettings().removal.removalProcessingEnabled;

export const runRemovalScan = async () => {
  if (!removalJobEnabled('scan')) return null;
  logger.info('Starting scheduled job: Removal Scan', { label: 'Jobs' });
  return removalScheduler.runCandidateSelection();
};

export const runRemovalProcessing = async () => {
  if (!removalJobEnabled('processing')) return null;
  logger.info('Starting scheduled job: Removal Processing', { label: 'Jobs' });
  return removalScheduler.runScheduledRemovalProcessing();
};

export const startRemovalScan = () => {
  void runRemovalScan().catch((error) =>
    logger.error('Removal Scan failed', {
      label: 'Removal Scheduler',
      error: error instanceof Error ? error.message : String(error),
    })
  );
};

export const startRemovalProcessing = () => {
  void runRemovalProcessing().catch((error) =>
    logger.error('Removal Processing failed', {
      label: 'Removal Scheduler',
      error: error instanceof Error ? error.message : String(error),
    })
  );
};
