import { MediaStatus } from '@server/constants/media';

export type TitleCardWatchState = 'watched' | 'not_watched' | 'unknown';

export type TitleCardStateIndicator = {
  id: 'availability' | 'watched';
  status: MediaStatus | 'watched';
  inProgress?: boolean;
};

export const buildTitleCardStateIndicators = ({
  currentStatus,
  watchState,
  inProgress = false,
}: {
  currentStatus?: MediaStatus;
  watchState?: TitleCardWatchState;
  inProgress?: boolean;
}): TitleCardStateIndicator[] => {
  const indicators: TitleCardStateIndicator[] = [];

  if (currentStatus && currentStatus !== MediaStatus.UNKNOWN) {
    indicators.push({
      id: 'availability',
      status: currentStatus,
      inProgress,
    });
  }

  if (watchState === 'watched') {
    indicators.push({ id: 'watched', status: 'watched' });
  }

  return indicators;
};
