import Button from '@app/components/Common/Button';
import CancelScheduledRemovalButton from '@app/components/Common/CancelScheduledRemovalButton';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Tooltip from '@app/components/Common/Tooltip';
import LibrarySelectionCheckbox from '@app/components/Library/LibrarySelectionCheckbox';
import {
  isLibrarySeasonSelected,
  type LibrarySelectionKey,
  type LibrarySelectionTarget,
} from '@app/components/Library/selection';
import useLibraryIndividualActions from '@app/components/Library/useLibraryIndividualActions';
import defineMessages from '@app/utils/defineMessages';
import { CalendarDateRangeIcon, TrashIcon } from '@heroicons/react/24/solid';
import type { LibrarySeriesDetailResponse } from '@server/interfaces/api/libraryInterfaces';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import { WatchedChipGroup } from './LibraryEngagement';
import { formatLibrarySize } from './presentation';

const messages = defineMessages('components.Library.SeriesDetail', {
  specials: 'Specials',
  episodes: '{count, plural, one {# episode} other {# episodes}}',
  archivedSize: '{size} archived',
  loading: 'Loading Series detail.',
  unableToLoad: 'Unable to load detail.',
  cancelRemoval: 'Cancel scheduled removal',
  scheduleRemoval: 'Schedule removal',
  removeNow: 'Remove',
  selectSeason: 'Select {season} from {seriesTitle}',
  confirmRemoval:
    'Permanently remove this item and its files from the configured service?',
});

interface SeriesDetailProps {
  canonicalMediaId: number;
  seriesTitle: string;
  readOnly: boolean;
  selectedKeys: ReadonlySet<LibrarySelectionKey>;
  eligibleSeasonNumbers: readonly number[];
  onSelectionChange: (
    target: LibrarySelectionTarget,
    selected: boolean,
    eligibleSeasonNumbers?: readonly number[]
  ) => void;
  onChanged: () => void;
}

const SeriesDetail = ({
  canonicalMediaId,
  seriesTitle,
  readOnly,
  selectedKeys,
  eligibleSeasonNumbers,
  onSelectionChange,
  onChanged,
}: SeriesDetailProps) => {
  const intl = useIntl();
  const { data, error, mutate } = useSWR<LibrarySeriesDetailResponse>(
    `/api/v1/library/${canonicalMediaId}/series-detail`
  );
  const detailResolved = Boolean(data || error);
  const [contentVisible, setContentVisible] = useState(false);
  const { isPending, run } = useLibraryIndividualActions(
    `series:${canonicalMediaId}`
  );

  useEffect(() => {
    if (!detailResolved) {
      setContentVisible(false);
      return;
    }

    const frame = window.requestAnimationFrame(() => setContentVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [detailResolved]);

  const wholeSeriesScheduled = data?.removalSchedules?.some(
    (schedule) => schedule.targetType === 'series'
  );

  return (
    <div className="relative">
      {!detailResolved && (
        <div
          aria-label={intl.formatMessage(messages.loading)}
          className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex h-10 items-center justify-center"
          role="status"
        >
          <SmallLoadingSpinner />
        </div>
      )}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          contentVisible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          {error && (
            <div className="py-3 text-sm text-red-400">
              {intl.formatMessage(messages.unableToLoad)}
            </div>
          )}
          {data && (
            <div className="grid grid-cols-1 gap-3 border-t border-gray-700 p-4 lg:grid-cols-2 2xl:grid-cols-3">
              {data.seasons.map((season) => {
                const actionKey = `season:${season.seasonNumber}`;
                const actionPending = isPending(actionKey);
                return (
                  <section
                    key={season.seasonNumber}
                    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-gray-900/40 px-3 py-2"
                  >
                    <div className="-ml-3 flex h-7 w-9 flex-shrink-0 items-center justify-center">
                      <LibrarySelectionCheckbox
                        checked={isLibrarySeasonSelected(
                          selectedKeys,
                          canonicalMediaId,
                          season.seasonNumber
                        )}
                        disabled={
                          !eligibleSeasonNumbers.includes(season.seasonNumber)
                        }
                        hitArea="season"
                        label={intl.formatMessage(messages.selectSeason, {
                          season: season.isSpecial
                            ? intl.formatMessage(messages.specials)
                            : `S${String(season.seasonNumber).padStart(2, '0')}`,
                          seriesTitle,
                        })}
                        onChange={(selected) =>
                          onSelectionChange(
                            {
                              type: 'season',
                              canonicalMediaId,
                              seasonNumber: season.seasonNumber,
                            },
                            selected,
                            eligibleSeasonNumbers
                          )
                        }
                      />
                    </div>
                    <div className="flex flex-shrink-0 items-center whitespace-nowrap font-semibold leading-[0.8125rem] text-gray-200">
                      <span className="tabular-nums">
                        {season.isSpecial
                          ? intl.formatMessage(messages.specials)
                          : `S${String(season.seasonNumber).padStart(2, '0')}`}
                      </span>
                      <span className="mx-1.5 text-gray-500" aria-hidden="true">
                        ·
                      </span>
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-normal leading-[0.8125rem] text-gray-200">
                          {intl.formatMessage(messages.episodes, {
                            count: season.availableEpisodeCount,
                          })}
                        </span>
                        {season.sizeBytes && (
                          <span className="text-xs font-normal leading-[0.8125rem] text-slate-300">
                            {readOnly
                              ? intl.formatMessage(messages.archivedSize, {
                                  size: formatLibrarySize(season.sizeBytes),
                                })
                              : formatLibrarySize(season.sizeBytes)}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      <WatchedChipGroup
                        users={season.users.map((viewer) => ({
                          ...viewer,
                          availableEpisodeCount: season.availableEpisodeCount,
                        }))}
                      />
                    </div>
                    {!readOnly && (
                      <div className="ml-auto flex flex-shrink-0 items-center gap-2">
                        {!readOnly &&
                          !wholeSeriesScheduled &&
                          (data.removalSchedules?.find(
                            (schedule) =>
                              schedule.targetType === 'season' &&
                              schedule.seasonNumber === season.seasonNumber
                          ) ? (
                            <CancelScheduledRemovalButton
                              label={intl.formatMessage(messages.cancelRemoval)}
                              disabled={actionPending}
                              onClick={() => {
                                const schedule = data.removalSchedules?.find(
                                  (item) =>
                                    item.targetType === 'season' &&
                                    item.seasonNumber === season.seasonNumber
                                );
                                if (!schedule) return;
                                void run({
                                  key: actionKey,
                                  actionLabel: intl.formatMessage(
                                    messages.cancelRemoval
                                  ),
                                  action: () =>
                                    axios.delete(
                                      `/api/v1/library/removal-schedules/${schedule.id}`
                                    ),
                                  refresh: () => mutate(),
                                  onCompleted: onChanged,
                                });
                              }}
                            />
                          ) : (
                            <Tooltip
                              content={intl.formatMessage(
                                messages.scheduleRemoval
                              )}
                            >
                              <Button
                                aria-label={intl.formatMessage(
                                  messages.scheduleRemoval
                                )}
                                buttonType="warning"
                                buttonSize="sm"
                                className="h-7 w-7 border-transparent bg-yellow-500/30 !p-0 hover:bg-yellow-500 focus:bg-yellow-500/80"
                                disabled={actionPending}
                                onClick={() => {
                                  void run({
                                    key: actionKey,
                                    actionLabel: intl.formatMessage(
                                      messages.scheduleRemoval
                                    ),
                                    action: () =>
                                      axios.post(
                                        `/api/v1/library/${canonicalMediaId}/removal-schedules`,
                                        {
                                          targetType: 'season',
                                          seasonNumber: season.seasonNumber,
                                        }
                                      ),
                                    refresh: () => mutate(),
                                    onCompleted: onChanged,
                                  });
                                }}
                              >
                                <CalendarDateRangeIcon className="!h-5 !w-5" />
                              </Button>
                            </Tooltip>
                          ))}
                        {!readOnly && (
                          <Tooltip
                            content={intl.formatMessage(messages.removeNow)}
                          >
                            <Button
                              aria-label={intl.formatMessage(
                                messages.removeNow
                              )}
                              buttonType="danger"
                              buttonSize="sm"
                              className="h-7 w-7 border-transparent bg-red-600/30 !p-0 hover:bg-red-600 focus:bg-red-600/80"
                              disabled={actionPending}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    intl.formatMessage(messages.confirmRemoval)
                                  )
                                )
                                  return;
                                void run({
                                  key: actionKey,
                                  actionLabel: intl.formatMessage(
                                    messages.removeNow
                                  ),
                                  action: () =>
                                    axios.post(
                                      `/api/v1/library/${canonicalMediaId}/remove`,
                                      {
                                        targetType: 'season',
                                        seasonNumber: season.seasonNumber,
                                      }
                                    ),
                                  refresh: () => mutate(),
                                  onCompleted: onChanged,
                                });
                              }}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SeriesDetail;
