import Button from '@app/components/Common/Button';
import CancelScheduledRemovalButton from '@app/components/Common/CancelScheduledRemovalButton';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import { invalidLeavingSoonPage } from '@app/components/LeavingSoon/pagination';
import TitleCard from '@app/components/TitleCard';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/solid';
import type {
  LeavingSoonItem,
  LeavingSoonResultsResponse,
  LibraryPresentationStatus,
  LibraryRemovalSchedule,
} from '@server/interfaces/api/libraryInterfaces';
import axios from 'axios';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.LeavingSoon', {
  title: 'Leaving Soon',
  description: 'Media currently scheduled for removal.',
  empty: 'Nothing is scheduled to leave.',
  unableToLoad: 'Unable to load Leaving Soon.',
  season: 'Season {seasonNumber}',
  leaves: 'Leaves {date}',
  cancelScheduledRemoval: 'Cancel scheduled removal',
  cancelTitle: 'Cancel scheduled removal?',
  cancelOne:
    'This will cancel only this scheduled removal. No media will be removed.',
  cancelMany:
    'This card has multiple scheduled removals. Select the exact schedule to cancel. No media will be removed.',
  cancelAction: 'Cancel schedule',
  cancelSuccess: 'Scheduled removal cancelled.',
  cancelError: 'Unable to cancel scheduled removal.',
  cancelRefreshError:
    'The schedule was cancelled, but Leaving Soon could not refresh. Reload to verify the current page.',
  movieTarget: 'Movie',
  seriesTarget: 'Series',
});

interface CancelDialogState {
  item: LeavingSoonItem;
  scheduleId: number | null;
}

const LeavingSoon = () => {
  const router = useRouter();
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const [cancelDialog, setCancelDialog] = useState<CancelDialogState | null>(
    null
  );
  const [cancelling, setCancelling] = useState(false);
  const page = Math.max(1, Number(router.query.page) || 1);
  const { data, error, mutate } = useSWR<LeavingSoonResultsResponse>(
    `/api/v1/leaving-soon?page=${page}`
  );
  useEffect(() => {
    const batchId = data?.presentation?.batchId;
    if (data?.presentation?.state !== 'pending' || !batchId) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async () => {
      if (cancelled || attempts >= 40) return;
      attempts += 1;
      try {
        const { data: status } = await axios.get<LibraryPresentationStatus>(
          `/api/v1/leaving-soon/presentation-status/${batchId}`
        );
        if (cancelled) return;
        if (status.state === 'pending') {
          timeout = setTimeout(poll, Math.min(500 * attempts, 2000));
          return;
        }
        if (status.state === 'complete' || status.state === 'partial') {
          await mutate();
        }
      } catch {
        // Missing, expired, or transiently unavailable batch status leaves the
        // current projection intact. Ordinary SWR revalidation can refresh it.
      }
    };
    timeout = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [data?.presentation?.batchId, data?.presentation?.state, mutate]);
  const canCancelSchedules = hasPermission(Permission.ADMIN);
  const selectedSchedule = cancelDialog?.item.schedules.find(
    (schedule) => schedule.id === cancelDialog.scheduleId
  );
  const formatScheduleTarget = (schedule: LibraryRemovalSchedule) => {
    const target =
      schedule.targetType === 'season'
        ? intl.formatMessage(messages.season, {
            seasonNumber: schedule.seasonNumber,
          })
        : intl.formatMessage(
            schedule.targetType === 'movie'
              ? messages.movieTarget
              : messages.seriesTarget
          );
    return `${target} · ${intl.formatMessage(messages.leaves, {
      date: intl.formatDate(schedule.removeAt, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    })}`;
  };
  const closeCancelDialog = () => {
    if (!cancelling) setCancelDialog(null);
  };
  const submitCancellation = async () => {
    if (!selectedSchedule || cancelling) return;
    setCancelling(true);
    let cancellationCompleted = false;
    try {
      await axios.delete(
        `/api/v1/library/removal-schedules/${selectedSchedule.id}`
      );
      cancellationCompleted = true;
      const refreshed = await mutate();
      if (!refreshed) throw new Error('Leaving Soon refresh returned no data.');
      const validPage = invalidLeavingSoonPage(page, refreshed.pageInfo.pages);
      if (validPage !== null) {
        await router.replace({
          pathname: router.pathname,
          query: { ...router.query, page: validPage },
        });
      }
      setCancelDialog(null);
      addToast(intl.formatMessage(messages.cancelSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (error) {
      const responseMessage =
        !cancellationCompleted &&
        axios.isAxiosError<{ message?: string }>(error)
          ? error.response?.data?.message
          : undefined;
      if (cancellationCompleted) setCancelDialog(null);
      addToast(
        cancellationCompleted
          ? intl.formatMessage(messages.cancelRefreshError)
          : (responseMessage ?? intl.formatMessage(messages.cancelError)),
        {
          appearance: 'error',
          autoDismiss: !cancellationCompleted,
        }
      );
    } finally {
      setCancelling(false);
    }
  };
  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <Transition as={Fragment} show={cancelDialog !== null}>
        {cancelDialog && (
          <Modal
            title={intl.formatMessage(messages.cancelTitle)}
            onCancel={cancelling ? undefined : closeCancelDialog}
            onOk={() => void submitCancellation()}
            okText={intl.formatMessage(messages.cancelAction)}
            okButtonType="danger"
            okDisabled={!selectedSchedule || cancelling}
            backgroundClickable={!cancelling}
          >
            <div className="space-y-3">
              <p>
                {intl.formatMessage(
                  cancelDialog.item.schedules.length > 1
                    ? messages.cancelMany
                    : messages.cancelOne
                )}
              </p>
              {cancelDialog.item.schedules.length > 1 ? (
                <div
                  aria-label={intl.formatMessage(
                    messages.cancelScheduledRemoval
                  )}
                  className="space-y-2"
                  role="radiogroup"
                >
                  {cancelDialog.item.schedules.map((schedule) => (
                    <label
                      className="flex cursor-pointer items-center gap-3 rounded-md bg-gray-700/60 px-3 py-2 hover:bg-gray-700"
                      key={schedule.id}
                    >
                      <input
                        checked={cancelDialog.scheduleId === schedule.id}
                        className="h-4 w-4 text-indigo-500 focus:ring-indigo-500"
                        name="leaving-soon-schedule"
                        onChange={() =>
                          setCancelDialog((current) =>
                            current
                              ? { ...current, scheduleId: schedule.id }
                              : current
                          )
                        }
                        type="radio"
                      />
                      <span>{formatScheduleTarget(schedule)}</span>
                    </label>
                  ))}
                </div>
              ) : (
                selectedSchedule && (
                  <p className="font-medium text-gray-100">
                    {formatScheduleTarget(selectedSchedule)}
                  </p>
                )
              )}
            </div>
          </Modal>
        )}
      </Transition>
      <div className="mb-6">
        <Header>{intl.formatMessage(messages.title)}</Header>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {!data && !error && <LoadingSpinner />}
      {error && (
        <div className="py-24 text-center text-xl text-red-400">
          {intl.formatMessage(messages.unableToLoad)}
        </div>
      )}
      {data && data.results.length === 0 && (
        <div className="py-24 text-center text-2xl text-gray-400">
          {intl.formatMessage(messages.empty)}
        </div>
      )}
      {data && data.results.length > 0 && (
        <ul className="cards-vertical">
          {data.results.map((item) => {
            const navigationHref = item.tmdbId
              ? item.mediaType === 'movie'
                ? `/movie/${item.tmdbId}`
                : `/tv/${item.tmdbId}`
              : null;
            return (
              <li className="leaving-soon-card" key={item.canonicalMediaId}>
                <TitleCard
                  id={item.tmdbId ?? item.canonicalMediaId}
                  image={item.posterPath ?? undefined}
                  title={item.title}
                  year={item.year?.toString()}
                  mediaType={item.mediaType === 'movie' ? 'movie' : 'tv'}
                  canExpand
                  navigationHref={navigationHref}
                  actionsDisabled
                  cornerAction={
                    canCancelSchedules && item.schedules.length > 0 ? (
                      <div className="leaving-soon-cancel-action">
                        <CancelScheduledRemovalButton
                          label={intl.formatMessage(
                            messages.cancelScheduledRemoval
                          )}
                          preserveColorsOnInteraction
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setCancelDialog({
                              item,
                              scheduleId:
                                item.schedules.length === 1
                                  ? item.schedules[0].id
                                  : null,
                            });
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
                        />
                      </div>
                    ) : undefined
                  }
                  persistentMetadata={
                    <div className="space-y-0.5">
                      {item.schedules.map((schedule) => (
                        <div key={schedule.id}>
                          {schedule.targetType === 'season' && (
                            <span className="mr-1">
                              {intl.formatMessage(messages.season, {
                                seasonNumber: schedule.seasonNumber,
                              })}
                              ·
                            </span>
                          )}
                          {intl.formatMessage(messages.leaves, {
                            date: intl.formatDate(schedule.removeAt, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            }),
                          })}
                        </div>
                      ))}
                    </div>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      {data && data.pageInfo.pages > 1 && (
        <nav className="mt-6 flex justify-center gap-2" aria-label="Pagination">
          <Button
            disabled={page <= 1}
            onClick={() => void router.push({ query: { page: page - 1 } })}
          >
            <ChevronLeftIcon />
            Previous
          </Button>
          <Button
            disabled={page >= data.pageInfo.pages}
            onClick={() => void router.push({ query: { page: page + 1 } })}
          >
            Next
            <ChevronRightIcon />
          </Button>
        </nav>
      )}
    </>
  );
};

export default LeavingSoon;
