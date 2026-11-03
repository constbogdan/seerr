import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import type { DownloadingItem } from '@server/lib/downloadtracker';

// Sonarr already supplies Episode titles on the wire, including synthetic
// Finalizing rows. This frontend hint does not add any API fields or reads.
export type DownloadTitleItem = DownloadingItem & {
  episode?: NonNullable<DownloadingItem['episode']> & { title?: string };
};

export const hasEpisodeCoordinates = (item: DownloadTitleItem): boolean =>
  item.mediaType === 'tv' &&
  !!item.episode &&
  Number.isSafeInteger(item.episode.seasonNumber) &&
  item.episode.seasonNumber >= 0 &&
  Number.isSafeInteger(item.episode.episodeNumber) &&
  item.episode.episodeNumber > 0;

export const finalizingEpisodeLabel = (
  item: DownloadTitleItem
): string | undefined => {
  const episode = item.episode;
  if (
    item.acquisitionPhase !== AcquisitionPhase.FINALIZING ||
    !episode ||
    !hasEpisodeCoordinates(item)
  )
    return undefined;
  const code = `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
  const title =
    typeof episode.title === 'string' ? episode.title.trim() : undefined;
  return title ? `${code} — ${title}` : code;
};
