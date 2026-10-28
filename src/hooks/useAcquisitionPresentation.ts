import {
  observeAcquisitionDownloads,
  type AcquisitionObservation,
} from '@app/utils/acquisitionObservation';
import { getAcquisitionPresentation } from '@app/utils/acquisitionPresentation';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { useEffect, useMemo, useRef } from 'react';

export default function useAcquisitionPresentation(
  items: readonly DownloadingItem[],
  scope: string,
  sample: object,
  validating: boolean,
  observeTransfers: boolean
) {
  const previous = useRef<AcquisitionObservation | undefined>(undefined);
  const observation = useMemo(
    () =>
      observeAcquisitionDownloads(
        observeTransfers ? items : [],
        scope,
        sample,
        validating,
        previous.current
      ),
    [items, scope, sample, validating, observeTransfers]
  );
  // Commit only after React accepts the render. No timers, requests, global
  // cache or mutation during render; unmount releases the whole observation.
  useEffect(() => {
    previous.current = observation;
  }, [observation]);
  return getAcquisitionPresentation(
    items,
    observeTransfers ? observation.advancing : undefined
  );
}
