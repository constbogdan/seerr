import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN,
  MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN,
  type WatchlistRouletteSettings,
} from '@server/constants/watchlistRoulette';
import type {
  WatchlistRouletteLastRun,
  WatchlistRouletteSettingsResponse,
  WatchlistRouletteSettingsUpdate,
} from '@server/interfaces/api/watchlistRouletteInterfaces';
import type { JobId } from '@server/lib/settings';
import axios from 'axios';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsWatchlistRoulette',
  {
    title: 'Watchlist Roulette',
    description:
      "Automatically request random Movies and Series from users' Watchlists.",
    requestOwner: 'Request owner',
    requestOwnerDescription:
      'Requests are automatically approved and attributed to this administrator.',
    chooseAdministrator: 'Choose an administrator',
    movies: 'Movies',
    series: 'Series',
    itemsPerRun: 'Items per run',
    lastRunSelections: 'Last-run selections',
    noLastRun: 'This job has not completed a run yet.',
    noSelections: 'The last run created no requests.',
    unavailableSelection: 'Request #{requestId} is no longer available.',
    openInSeerr: 'Open in Seerr',
    openInRadarr: 'Open in Radarr',
    openInSonarr: 'Open in Sonarr',
    lastRunSummary:
      '{date} · Requested {requested}; skipped {skipped}; failed {failed}',
    failedRun: 'The last run failed: {reason}.',
    enabled: '{name} enabled.',
    disabled: '{name} disabled.',
    save: 'Save changes',
    saving: 'Saving…',
    saved: 'Watchlist Roulette settings saved.',
    saveFailed: 'Unable to save Watchlist Roulette settings.',
    loadFailed: 'Unable to load Watchlist Roulette settings.',
    retry: 'Retry',
    invalidCount: 'Enter a whole number from 1 through 100.',
    ownerRequired:
      'Select and save a current administrator before enabling a Watchlist Roulette job.',
    unsavedConfiguration:
      'Save the Watchlist Roulette configuration before enabling a job.',
    jobUpdateFailed: 'Unable to update the Watchlist Roulette job: {message}',
  }
);

interface RouletteJob {
  id: JobId;
  enabled: boolean;
  configurableEnabled: boolean;
}

const configuration = (
  settings: WatchlistRouletteSettings
): WatchlistRouletteSettingsUpdate => ({
  requestOwnerUserId: settings.requestOwnerUserId,
  movieItemsPerRun: settings.movieItemsPerRun,
  seriesItemsPerRun: settings.seriesItemsPerRun,
});

const LastRun = ({
  run,
  mediaLabel,
}: {
  run: WatchlistRouletteLastRun | null;
  mediaLabel: 'Radarr' | 'Sonarr';
}) => {
  const intl = useIntl();
  if (!run) {
    return (
      <p className="text-sm text-gray-400">
        {intl.formatMessage(messages.noLastRun)}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-400">
        {intl.formatMessage(messages.lastRunSummary, {
          date: intl.formatDate(new Date(run.summary.completedAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
          requested: run.summary.requested,
          skipped: run.summary.skipped,
          failed: run.summary.failed,
        })}
      </p>
      {run.summary.status === 'failed' && run.summary.failureCode && (
        <p className="text-sm text-red-400" role="status">
          {intl.formatMessage(messages.failedRun, {
            reason: run.summary.failureCode.replaceAll('-', ' '),
          })}
        </p>
      )}
      {run.selections.length === 0 ? (
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.noSelections)}
        </p>
      ) : (
        <ul className="space-y-2">
          {run.selections.map((selection) => (
            <li
              key={selection.requestId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm"
            >
              <span className="min-w-0 font-medium text-white">
                {selection.title ??
                  intl.formatMessage(messages.unavailableSelection, {
                    requestId: selection.requestId,
                  })}
                {selection.title && selection.year
                  ? ` (${selection.year})`
                  : ''}
              </span>
              <span className="flex flex-wrap gap-3 text-xs">
                {selection.seerrUrl && (
                  <a
                    href={selection.seerrUrl}
                    className="text-indigo-300 hover:underline"
                  >
                    {intl.formatMessage(messages.openInSeerr)}
                  </a>
                )}
                {selection.servarrUrl && (
                  <a
                    href={selection.servarrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-300 hover:underline"
                  >
                    {intl.formatMessage(
                      mediaLabel === 'Radarr'
                        ? messages.openInRadarr
                        : messages.openInSonarr
                    )}
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const SettingsWatchlistRoulette = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<WatchlistRouletteSettingsResponse>(
    '/api/v1/settings/watchlist-roulette'
  );
  const {
    data: jobs,
    error: jobsError,
    mutate: mutateJobs,
  } = useSWR<RouletteJob[]>('/api/v1/settings/jobs');
  const [values, setValues] = useState<WatchlistRouletteSettingsUpdate | null>(
    null
  );
  const [savedValues, setSavedValues] =
    useState<WatchlistRouletteSettingsUpdate | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatingJob, setUpdatingJob] = useState<JobId | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!data || initializedRef.current) return;
    const next = configuration(data.settings);
    initializedRef.current = true;
    setValues(next);
    setSavedValues(next);
  }, [data]);

  const dirty =
    values !== null &&
    savedValues !== null &&
    JSON.stringify(values) !== JSON.stringify(savedValues);
  const countsValid =
    values !== null &&
    [values.movieItemsPerRun, values.seriesItemsPerRun].every(
      (value) =>
        Number.isSafeInteger(value) &&
        value >= MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN &&
        value <= MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN
    );
  const jobsById = useMemo(
    () => new Map(jobs?.map((job) => [job.id, job]) ?? []),
    [jobs]
  );

  const save = async () => {
    if (!values || !countsValid || saving) return;
    setSaving(true);
    try {
      const response = await axios.post<WatchlistRouletteSettings>(
        '/api/v1/settings/watchlist-roulette',
        values
      );
      const next = configuration(response.data);
      setValues(next);
      setSavedValues(next);
      if (data) await mutate({ ...data, settings: response.data }, false);
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.saveFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  const setJobEnabled = async (
    jobId: 'watchlist-roulette-movies' | 'watchlist-roulette-series',
    enabled: boolean,
    name: string
  ) => {
    if (updatingJob) return;
    if (enabled && dirty) {
      addToast(intl.formatMessage(messages.unsavedConfiguration), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }
    if (enabled && !savedValues?.requestOwnerUserId) {
      addToast(intl.formatMessage(messages.ownerRequired), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }
    setUpdatingJob(jobId);
    try {
      const response = await axios.post<RouletteJob>(
        `/api/v1/settings/jobs/${jobId}/enabled`,
        { enabled }
      );
      await mutateJobs(
        (current) =>
          current?.map((job) =>
            job.id === response.data.id ? { ...job, ...response.data } : job
          ),
        { revalidate: false }
      );
      addToast(
        intl.formatMessage(enabled ? messages.enabled : messages.disabled, {
          name,
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (jobError) {
      const message =
        axios.isAxiosError(jobError) &&
        typeof jobError.response?.data?.message === 'string'
          ? jobError.response.data.message
          : intl.formatMessage(messages.saveFailed);
      addToast(intl.formatMessage(messages.jobUpdateFailed, { message }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setUpdatingJob(null);
    }
  };

  if (!data && !error) return <LoadingSpinner />;
  if (error || !data || !values) {
    return (
      <div className="rounded-md bg-gray-800 p-4 text-red-400" role="alert">
        <p>{intl.formatMessage(messages.loadFailed)}</p>
        <Button className="mt-3" onClick={() => void mutate()}>
          {intl.formatMessage(messages.retry)}
        </Button>
      </div>
    );
  }

  const movieJob = jobsById.get('watchlist-roulette-movies');
  const seriesJob = jobsById.get('watchlist-roulette-series');
  const sections = [
    {
      id: 'watchlist-roulette-movies' as const,
      title: intl.formatMessage(messages.movies),
      count: values.movieItemsPerRun,
      updateCount: (value: number) =>
        setValues((current) =>
          current ? { ...current, movieItemsPerRun: value } : current
        ),
      job: movieJob,
      run: data.lastMovieRun,
      provider: 'Radarr' as const,
    },
    {
      id: 'watchlist-roulette-series' as const,
      title: intl.formatMessage(messages.series),
      count: values.seriesItemsPerRun,
      updateCount: (value: number) =>
        setValues((current) =>
          current ? { ...current, seriesItemsPerRun: value } : current
        ),
      job: seriesJob,
      run: data.lastSeriesRun,
      provider: 'Sonarr' as const,
    },
  ];

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div>
        <h2 className="text-xl font-bold">
          {intl.formatMessage(messages.title)}
        </h2>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      <section className="mt-6 rounded-lg bg-gray-800 p-5 shadow ring-1 ring-gray-700">
        <label htmlFor="watchlist-roulette-owner" className="text-label">
          {intl.formatMessage(messages.requestOwner)}
        </label>
        <p className="mb-3 mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.requestOwnerDescription)}
        </p>
        <select
          id="watchlist-roulette-owner"
          className="w-full max-w-[200px]"
          value={values.requestOwnerUserId ?? ''}
          onChange={(event) =>
            setValues((current) =>
              current
                ? {
                    ...current,
                    requestOwnerUserId: event.target.value
                      ? Number(event.target.value)
                      : null,
                  }
                : current
            )
          }
        >
          <option value="">
            {intl.formatMessage(messages.chooseAdministrator)}
          </option>
          {data.administrators.map((administrator) => (
            <option key={administrator.id} value={administrator.id}>
              {administrator.displayName}
            </option>
          ))}
        </select>
      </section>

      {jobsError && (
        <p className="mt-4 text-sm text-red-400" role="alert">
          {intl.formatMessage(messages.jobUpdateFailed, {
            message: intl.formatMessage(messages.loadFailed),
          })}
        </p>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {sections.map((section) => (
          <section
            key={section.id}
            className="rounded-lg bg-gray-800 p-5 shadow ring-1 ring-gray-700"
          >
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-lg font-semibold">{section.title}</h3>
              <SlideCheckbox
                checked={section.job?.enabled ?? false}
                disabled={
                  !section.job?.configurableEnabled ||
                  updatingJob === section.id
                }
                ariaLabel={section.title}
                onClick={() =>
                  void setJobEnabled(
                    section.id,
                    !(section.job?.enabled ?? false),
                    section.title
                  )
                }
              />
            </div>
            <div className="mt-5">
              <label htmlFor={`${section.id}-count`} className="text-label">
                {intl.formatMessage(messages.itemsPerRun)}
              </label>
              <input
                id={`${section.id}-count`}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                min={MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN}
                max={MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN}
                className="mt-2 h-10 w-full max-w-[120px]"
                value={section.count}
                onChange={(event) =>
                  section.updateCount(Number(event.target.value))
                }
              />
              {(!Number.isSafeInteger(section.count) ||
                section.count < MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN ||
                section.count > MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN) && (
                <p className="mt-1 text-sm text-red-400">
                  {intl.formatMessage(messages.invalidCount)}
                </p>
              )}
            </div>
            <div className="mt-5 border-t border-gray-700 pt-4">
              <h4 className="mb-2 text-sm font-semibold">
                {intl.formatMessage(messages.lastRunSelections)}
              </h4>
              <LastRun run={section.run} mediaLabel={section.provider} />
            </div>
          </section>
        ))}
      </div>

      <div className="actions">
        <Button
          buttonType="primary"
          disabled={!dirty || !countsValid || saving}
          onClick={() => void save()}
        >
          {intl.formatMessage(saving ? messages.saving : messages.save)}
        </Button>
      </div>
    </>
  );
};

export default SettingsWatchlistRoulette;
