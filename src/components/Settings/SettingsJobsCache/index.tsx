import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import SynchronizationContainmentStatus from '@app/components/Settings/SynchronizationContainmentStatus';
import useLocale from '@app/hooks/useLocale';
import useSettings from '@app/hooks/useSettings';

import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import { Transition } from '@headlessui/react';
import { PlayIcon, StopIcon, TrashIcon } from '@heroicons/react/24/outline';
import { PencilIcon } from '@heroicons/react/24/solid';
import { MediaServerType } from '@server/constants/server';
import type {
  CacheItem,
  CacheResponse,
} from '@server/interfaces/api/settingsInterfaces';
import type { JobId } from '@server/lib/settings';
import axios from 'axios';
import cronstrue from 'cronstrue/i18n';
import humanizeDuration from 'humanize-duration';
import { Fragment, useReducer, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages: { [messageName: string]: MessageDescriptor } = defineMessages(
  'components.Settings.SettingsJobsCache',
  {
    jobsandcache: 'Jobs & Cache',
    jobs: 'Jobs',
    jobsDescription:
      'Seerr performs certain maintenance tasks as regularly-scheduled jobs, but they can also be manually triggered below. Manually running a job will not alter its schedule.',
    jobname: 'Job Name',
    jobtype: 'Type',
    nextexecution: 'Next Execution',
    runnow: 'Run Now',
    disabled: 'Disabled',
    suppressed: 'Suppressed by synchronization mode',
    canceljob: 'Cancel Job',
    jobstarted: '{jobname} started.',
    jobcancelled: '{jobname} canceled.',
    jobresult:
      'Moved {moved}; blocked {blocked}; reconciliation required {reconciliation}',
    rouletteJobResult:
      'Requested {requested}; skipped {skipped}; failed {failed}',
    lastExecution: 'Last run {date}',
    process: 'Process',
    command: 'Command',
    cache: 'Cache',
    cacheDescription:
      'Seerr caches requests to external API endpoints to optimize performance and avoid making unnecessary API calls.',
    cacheflushed: '{cachename} cache flushed.',
    cachename: 'Cache Name',
    cachehits: 'Hits',
    cachemisses: 'Misses',
    cachekeys: 'Total Keys',
    cacheksize: 'Key Size',
    cachevsize: 'Value Size',
    flushcache: 'Flush Cache',
    dnsCache: 'DNS Cache',
    dnsCacheDescription:
      'Seerr caches DNS lookups to optimize performance and avoid making unnecessary API calls.',
    dnscacheflushed: '{hostname} dns cache flushed.',
    dnscachename: 'Hostname',
    dnscacheactiveaddress: 'Active Address',
    dnscachehits: 'Hits',
    dnscachemisses: 'Misses',
    dnscacheage: 'Age',
    flushdnscache: 'Flush DNS Cache',
    dnsCacheGlobalStats: 'Global DNS Cache Stats',
    dnsCacheGlobalStatsDescription:
      'These stats are aggregated across all DNS cache entries.',
    dnsNoCacheEntries: 'No DNS lookups have been cached yet.',
    size: 'Size',
    hits: 'Hits',
    misses: 'Misses',
    failures: 'Failures',
    ipv4Fallbacks: 'IPv4 Fallbacks',
    hitRate: 'Hit Rate',
    unknownJob: 'Unknown Job',
    'plex-recently-added-scan': 'Plex Recently Added Scan',
    'plex-full-scan': 'Plex Full Library Scan',
    'plex-watchlist-sync': 'Plex Watchlist Sync',
    'plex-refresh-token': 'Plex Refresh Token',
    'jellyfin-full-scan': 'Jellyfin Full Library Scan',
    'jellyfin-recently-added-scan': 'Jellyfin Recently Added Scan',
    'availability-sync': 'Media Availability Sync',
    'radarr-scan': 'Radarr Scan',
    'sonarr-scan': 'Sonarr Scan',
    'download-sync': 'Download Sync',
    'download-sync-reset': 'Download Sync Reset',
    'image-cache-cleanup': 'Image Cache Cleanup',
    'process-blocklisted-tags': 'Process Blocklisted Tags',
    'watchlist-metadata-backfill': 'Watchlist Metadata Backfill',
    'watchlist-metadata-backfill-description':
      'Adds missing genre information to Watchlist items.',
    'watchlist-play-state-sync': 'Watchlist Play State Sync',
    'current-jellyfin-viewing-sync': 'Jellyfin Activity Sync',
    'library-history-hydration': 'Library Sync',
    'removal-candidate-selection': 'Removal Scan',
    'removal-candidate-selection-description':
      'Finds media eligible for scheduled removal.',
    'scheduled-removal-processing': 'Removal Processing',
    'scheduled-removal-processing-description':
      'Processes scheduled removals when their deadlines arrive.',
    'series-relocation': 'Series Relocation',
    'series-relocation-description':
      'Automatically relocates eligible Series between storage volumes.',
    'watchlist-roulette-movies': 'Watchlist Roulette Movies',
    'watchlist-roulette-movies-description':
      "Automatically requests random Movies from users' Watchlists.",
    'watchlist-roulette-series': 'Watchlist Roulette Series',
    'watchlist-roulette-series-description':
      "Automatically requests Season 1 of random Series from users' Watchlists.",
    'watchlist-play-state-sync-description':
      "Updates watched status and progress for each user's Watchlist.",
    'current-jellyfin-viewing-sync-description':
      'Updates what each user has watched in Jellyfin.',
    'library-history-hydration-description':
      'Keeps your Library in sync with your local media files.',
    'fresh-sync': 'Fresh Sync',
    'fresh-sync-description':
      'Finds new releases matching your selected discovery sources.',
    'fresh-reconciliation': 'Fresh Reconciliation',
    'fresh-reconciliation-description':
      'Keeps Fresh results up to date as media becomes available or changes.',
    editJobSchedule: 'Modify Job',
    jobScheduleEditSaved: 'Job edited successfully!',
    jobScheduleEditFailed: 'Something went wrong while saving the job.',
    editJobScheduleCurrent: 'Current Frequency',
    editJobSchedulePrompt: 'New Frequency',
    editJobScheduleSelectorDays:
      'Every {jobScheduleDays, plural, one {day} other {{jobScheduleDays} days}}',
    editJobScheduleSelectorHours:
      'Every {jobScheduleHours, plural, one {hour} other {{jobScheduleHours} hours}}',
    editJobScheduleSelectorMinutes:
      'Every {jobScheduleMinutes, plural, one {minute} other {{jobScheduleMinutes} minutes}}',
    editJobScheduleSelectorSeconds:
      'Every {jobScheduleSeconds, plural, one {second} other {{jobScheduleSeconds} seconds}}',
    imagecache: 'Image Cache',
    imagecacheDescription:
      'When enabled in settings, Seerr will proxy and cache images from pre-configured external sources. Cached images are saved into your config folder. You can find the files in <code>{appDataPath}/cache/images</code>.',
    imagecachecount: 'Images Cached',
    imagecachesize: 'Total Cache Size',
    usersavatars: "Users' Avatars",
  }
);

interface Job {
  id: JobId;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  nextExecutionTime: string | null;
  running: boolean;
  enabled: boolean;
  configurableEnabled: boolean;
  lastResult?: Record<string, unknown> | null;
  lastExecutionTime?: string | null;
  scheduledExecutionAllowed: boolean;
  manualExecutionAllowed: boolean;
}

const numericResult = (
  result: Record<string, unknown> | null | undefined,
  key: string
): number | null =>
  result && typeof result[key] === 'number' ? (result[key] as number) : null;

type JobModalState = {
  isOpen?: boolean;
  job?: Job;
  scheduleDays: number;
  scheduleHours: number;
  scheduleMinutes: number;
  scheduleSeconds: number;
};

type JobModalAction =
  | {
      type: 'set';
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
    }
  | {
      type: 'close';
    }
  | { type: 'open'; job?: Job };

const jobModalReducer = (
  state: JobModalState,
  action: JobModalAction
): JobModalState => {
  switch (action.type) {
    case 'close':
      return {
        ...state,
        isOpen: false,
      };

    case 'open':
      return {
        isOpen: true,
        job: action.job,
        scheduleDays: 1,
        scheduleHours: 1,
        scheduleMinutes: 5,
        scheduleSeconds: 30,
      };

    case 'set':
      return {
        ...state,
        scheduleDays: action.days ?? state.scheduleDays,
        scheduleHours: action.hours ?? state.scheduleHours,
        scheduleMinutes: action.minutes ?? state.scheduleMinutes,
        scheduleSeconds: action.seconds ?? state.scheduleSeconds,
      };
  }
};

const SettingsJobs = () => {
  const intl = useIntl();
  const { locale } = useLocale();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<Job[]>('/api/v1/settings/jobs', {
    refreshInterval: 5000,
  });
  const { data: appData } = useSWR('/api/v1/status/appdata');
  const { data: cacheData, mutate: cacheRevalidate } = useSWR<CacheResponse>(
    '/api/v1/settings/cache',
    {
      refreshInterval: 10000,
    }
  );

  const [jobModalState, dispatch] = useReducer(jobModalReducer, {
    isOpen: false,
    scheduleDays: 1,
    scheduleHours: 1,
    scheduleMinutes: 5,
    scheduleSeconds: 30,
  });
  const [isSaving, setIsSaving] = useState(false);
  const settings = useSettings();
  const jobMessages = { ...messages };
  if (settings.currentSettings.mediaServerType === MediaServerType.EMBY) {
    jobMessages['jellyfin-recently-added-scan'] = {
      id: 'jellyfin-recently-added-scan',
      defaultMessage: 'Emby Recently Added Scan',
    };
    jobMessages['jellyfin-full-scan'] = {
      id: 'jellyfin-full-scan',
      defaultMessage: 'Emby Full Library Scan',
    };
  }
  const orderedJobs = data?.slice().sort((left, right) => {
    const displayedNameOrder = intl
      .formatMessage(jobMessages[left.id] ?? messages.unknownJob)
      .localeCompare(
        intl.formatMessage(jobMessages[right.id] ?? messages.unknownJob),
        locale
      );
    return displayedNameOrder || left.id.localeCompare(right.id, locale);
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const runJob = async (job: Job) => {
    await axios.post(`/api/v1/settings/jobs/${job.id}/run`);
    addToast(
      intl.formatMessage(messages.jobstarted, {
        jobname: intl.formatMessage(messages[job.id] ?? messages.unknownJob),
      }),
      {
        appearance: 'success',
        autoDismiss: true,
      }
    );
    revalidate();
  };

  const cancelJob = async (job: Job) => {
    await axios.post(`/api/v1/settings/jobs/${job.id}/cancel`);
    addToast(
      intl.formatMessage(messages.jobcancelled, {
        jobname: intl.formatMessage(messages[job.id] ?? messages.unknownJob),
      }),
      {
        appearance: 'error',
        autoDismiss: true,
      }
    );
    revalidate();
  };

  const flushCache = async (cache: CacheItem) => {
    await axios.post(`/api/v1/settings/cache/${cache.id}/flush`);
    addToast(
      intl.formatMessage(messages.cacheflushed, { cachename: cache.name }),
      {
        appearance: 'success',
        autoDismiss: true,
      }
    );
    cacheRevalidate();
  };

  const flushDnsCache = async (hostname: string) => {
    await axios.post(`/api/v1/settings/cache/dns/${hostname}/flush`);
    addToast(
      intl.formatMessage(messages.dnscacheflushed, { hostname: hostname }),
      {
        appearance: 'success',
        autoDismiss: true,
      }
    );
    cacheRevalidate();
  };

  const scheduleJob = async () => {
    const jobScheduleCron = ['0', '0', '*', '*', '*', '*'];

    try {
      if (jobModalState.job?.interval === 'seconds') {
        jobScheduleCron.splice(0, 2, `*/${jobModalState.scheduleSeconds}`, '*');
      } else if (jobModalState.job?.interval === 'minutes') {
        jobScheduleCron[1] = `*/${jobModalState.scheduleMinutes}`;
      } else if (jobModalState.job?.interval === 'hours') {
        jobScheduleCron[2] = `*/${jobModalState.scheduleHours}`;
      } else if (jobModalState.job?.interval === 'days') {
        jobScheduleCron[2] = '1';
        jobScheduleCron[3] = `*/${jobModalState.scheduleDays}`;
      } else {
        // jobs with interval: fixed should not be editable
        throw new Error();
      }

      setIsSaving(true);
      await axios.post(
        `/api/v1/settings/jobs/${jobModalState.job.id}/schedule`,
        {
          schedule: jobScheduleCron.join(' '),
        }
      );

      addToast(intl.formatMessage(messages.jobScheduleEditSaved), {
        appearance: 'success',
        autoDismiss: true,
      });

      dispatch({ type: 'close' });
      revalidate();
    } catch {
      addToast(intl.formatMessage(messages.jobScheduleEditFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const formatAge = (milliseconds: number): string => {
    return humanizeDuration(milliseconds, {
      units: ['m', 's'],
      round: true,
      language: locale,
    });
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.jobsandcache),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <SynchronizationContainmentStatus />
      <Transition
        as={Fragment}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={jobModalState.isOpen}
      >
        <Modal
          title={intl.formatMessage(messages.editJobSchedule)}
          okText={
            isSaving
              ? intl.formatMessage(globalMessages.saving)
              : intl.formatMessage(globalMessages.save)
          }
          onCancel={() => dispatch({ type: 'close' })}
          okDisabled={isSaving}
          onOk={() => scheduleJob()}
        >
          <div className="section">
            <form className="mb-6">
              <div className="form-row">
                <label className="text-label">
                  {intl.formatMessage(messages.editJobScheduleCurrent)}
                </label>
                <div className="form-input-area mb-1 mt-2">
                  <div>
                    {jobModalState.job &&
                      cronstrue.toString(jobModalState.job.cronSchedule, {
                        locale,
                      })}
                  </div>
                  <div className="text-sm text-gray-500">
                    {jobModalState.job?.cronSchedule}
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="jobSchedule" className="text-label">
                  {intl.formatMessage(messages.editJobSchedulePrompt)}
                </label>
                <div className="form-input-area">
                  {jobModalState.job?.interval === 'seconds' ? (
                    <select
                      name="jobScheduleSeconds"
                      className="inline"
                      value={jobModalState.scheduleSeconds}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          seconds: Number(e.target.value),
                        })
                      }
                    >
                      {[30, 45, 60].map((v) => (
                        <option value={v} key={`jobScheduleSeconds-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorSeconds,
                            {
                              jobScheduleSeconds: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  ) : jobModalState.job?.interval === 'minutes' ? (
                    <select
                      name="jobScheduleMinutes"
                      className="inline"
                      value={jobModalState.scheduleMinutes}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          minutes: Number(e.target.value),
                        })
                      }
                    >
                      {[5, 10, 15, 20, 30, 60].map((v) => (
                        <option value={v} key={`jobScheduleMinutes-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorMinutes,
                            {
                              jobScheduleMinutes: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  ) : jobModalState.job?.interval === 'days' ? (
                    <select
                      name="jobScheduleDays"
                      className="inline"
                      value={jobModalState.scheduleDays}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          days: Number(e.target.value),
                        })
                      }
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30].map((v) => (
                        <option value={v} key={`jobScheduleDays-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorDays,
                            {
                              jobScheduleDays: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      name="jobScheduleHours"
                      className="inline"
                      value={jobModalState.scheduleHours}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          hours: Number(e.target.value),
                        })
                      }
                    >
                      {[1, 2, 3, 4, 6, 8, 12, 24, 48, 72].map((v) => (
                        <option value={v} key={`jobScheduleHours-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorHours,
                            {
                              jobScheduleHours: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </form>
          </div>
        </Modal>
      </Transition>

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.jobs)}</h3>
        <p className="description">
          {intl.formatMessage(messages.jobsDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.jobname)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.jobtype)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.nextexecution)}</Table.TH>
              <Table.TH />
            </tr>
          </thead>
          <Table.TBody>
            {orderedJobs?.map((job) => (
              <tr key={`job-list-${job.id}`}>
                <Table.TD>
                  <div className="flex items-center text-sm leading-5 text-white">
                    <span>
                      {intl.formatMessage(
                        jobMessages[job.id] ?? messages.unknownJob
                      )}
                    </span>
                    {job.running && <Spinner className="ml-2 h-5 w-5" />}
                  </div>
                  {messages[`${job.id}-description`] && (
                    <div className="mt-1 text-xs text-gray-400">
                      {intl.formatMessage(messages[`${job.id}-description`])}
                    </div>
                  )}
                  {job.id === 'series-relocation' && job.lastResult && (
                    <div className="mt-1 text-xs text-gray-400">
                      {intl.formatMessage(messages.jobresult, {
                        moved: numericResult(job.lastResult, 'moved') ?? 0,
                        blocked: numericResult(job.lastResult, 'blocked') ?? 0,
                        reconciliation:
                          numericResult(
                            job.lastResult,
                            'needsReconciliation'
                          ) ?? 0,
                      })}
                    </div>
                  )}
                  {(job.id === 'watchlist-roulette-movies' ||
                    job.id === 'watchlist-roulette-series') &&
                    job.lastResult && (
                      <div className="mt-1 text-xs text-gray-400">
                        {intl.formatMessage(messages.rouletteJobResult, {
                          requested:
                            numericResult(job.lastResult, 'requested') ?? 0,
                          skipped:
                            numericResult(job.lastResult, 'skipped') ?? 0,
                          failed: numericResult(job.lastResult, 'failed') ?? 0,
                        })}
                      </div>
                    )}
                  {job.lastExecutionTime && (
                    <div className="mt-1 text-xs text-gray-400">
                      {intl.formatMessage(messages.lastExecution, {
                        date: intl.formatDate(new Date(job.lastExecutionTime), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }),
                      })}
                    </div>
                  )}
                </Table.TD>
                <Table.TD>
                  <Badge
                    badgeType={job.type === 'process' ? 'primary' : 'warning'}
                    className="uppercase"
                  >
                    {job.type === 'process'
                      ? intl.formatMessage(messages.process)
                      : intl.formatMessage(messages.command)}
                  </Badge>
                </Table.TD>
                <Table.TD>
                  <div className="text-sm leading-5 text-white">
                    {!job.enabled ? (
                      intl.formatMessage(messages.disabled)
                    ) : !job.scheduledExecutionAllowed ? (
                      intl.formatMessage(messages.suppressed)
                    ) : job.nextExecutionTime ? (
                      <FormattedRelativeTime
                        value={Math.floor(
                          (new Date(job.nextExecutionTime).getTime() -
                            Date.now()) /
                            1000
                        )}
                        updateIntervalInSeconds={1}
                        numeric="auto"
                      />
                    ) : (
                      intl.formatMessage(messages.disabled)
                    )}
                  </div>
                </Table.TD>
                <Table.TD alignText="right">
                  {job.interval !== 'fixed' && (
                    <Button
                      className="mr-2"
                      buttonType="warning"
                      onClick={() => dispatch({ type: 'open', job })}
                    >
                      <PencilIcon />
                      <span>{intl.formatMessage(globalMessages.edit)}</span>
                    </Button>
                  )}
                  {job.running ? (
                    <Button buttonType="danger" onClick={() => cancelJob(job)}>
                      <StopIcon />
                      <span>{intl.formatMessage(messages.canceljob)}</span>
                    </Button>
                  ) : (
                    <Button
                      buttonType="primary"
                      disabled={!job.enabled || !job.manualExecutionAllowed}
                      onClick={() => runJob(job)}
                    >
                      <PlayIcon />
                      <span>{intl.formatMessage(messages.runnow)}</span>
                    </Button>
                  )}
                </Table.TD>
              </tr>
            ))}
          </Table.TBody>
        </Table>
      </div>
      <div>
        <h3 className="heading">{intl.formatMessage(messages.cache)}</h3>
        <p className="description">
          {intl.formatMessage(messages.cacheDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.cachename)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachehits)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachemisses)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachekeys)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cacheksize)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachevsize)}</Table.TH>
              <Table.TH />
            </tr>
          </thead>
          <Table.TBody>
            {cacheData?.apiCaches?.map((cache) => (
              <tr key={`cache-list-${cache.id}`}>
                <Table.TD>{cache.name}</Table.TD>
                <Table.TD>{intl.formatNumber(cache.stats.hits)}</Table.TD>
                <Table.TD>{intl.formatNumber(cache.stats.misses)}</Table.TD>
                <Table.TD>{intl.formatNumber(cache.stats.keys)}</Table.TD>
                <Table.TD>{formatBytes(cache.stats.ksize)}</Table.TD>
                <Table.TD>{formatBytes(cache.stats.vsize)}</Table.TD>
                <Table.TD alignText="right">
                  <Button buttonType="danger" onClick={() => flushCache(cache)}>
                    <TrashIcon />
                    <span>{intl.formatMessage(messages.flushcache)}</span>
                  </Button>
                </Table.TD>
              </tr>
            ))}
          </Table.TBody>
        </Table>
      </div>
      {cacheData?.dnsCache != null && (
        <>
          <div>
            <h3 className="heading">{intl.formatMessage(messages.dnsCache)}</h3>
            <p className="description">
              {intl.formatMessage(messages.dnsCacheDescription)}
            </p>
          </div>
          <div className="section">
            <Table>
              <thead>
                <tr>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachename)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscacheactiveaddress)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachehits)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachemisses)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscacheage)}
                  </Table.TH>
                  <Table.TH />
                </tr>
              </thead>
              <Table.TBody>
                {(() => {
                  if (!cacheData) {
                    return (
                      <tr>
                        <Table.TD colSpan={6} alignText="center">
                          <LoadingSpinner />
                        </Table.TD>
                      </tr>
                    );
                  }

                  const entries = Object.entries(
                    cacheData.dnsCache?.entries ?? {}
                  );

                  if (entries.length === 0) {
                    return (
                      <tr>
                        <Table.TD colSpan={6} alignText="center">
                          {intl.formatMessage(messages.dnsNoCacheEntries)}
                        </Table.TD>
                      </tr>
                    );
                  }

                  return entries.map(([hostname, data]) => (
                    <tr key={`cache-list-${hostname}`}>
                      <Table.TD>{hostname}</Table.TD>
                      <Table.TD>{data.activeAddress}</Table.TD>
                      <Table.TD>{intl.formatNumber(data.hits)}</Table.TD>
                      <Table.TD>{intl.formatNumber(data.misses)}</Table.TD>
                      <Table.TD>{formatAge(data.age)}</Table.TD>
                      <Table.TD alignText="right">
                        <Button
                          buttonType="danger"
                          onClick={() => flushDnsCache(hostname)}
                        >
                          <TrashIcon />
                          <span>
                            {intl.formatMessage(messages.flushdnscache)}
                          </span>
                        </Button>
                      </Table.TD>
                    </tr>
                  ));
                })()}
              </Table.TBody>
            </Table>
          </div>
          <div>
            <h3 className="heading">
              {intl.formatMessage(messages.dnsCacheGlobalStats)}
            </h3>
            <p className="description">
              {intl.formatMessage(messages.dnsCacheGlobalStatsDescription)}
            </p>
          </div>
          <div className="section">
            {!cacheData ? (
              <LoadingSpinner />
            ) : (
              <Table>
                <thead>
                  <tr>
                    {Object.entries(cacheData.dnsCache?.stats ?? {})
                      .filter(([statName]) => statName !== 'maxSize')
                      .map(([statName]) => (
                        <Table.TH key={`dns-stat-header-${statName}`}>
                          {messages[statName]
                            ? intl.formatMessage(messages[statName])
                            : statName}
                        </Table.TH>
                      ))}
                  </tr>
                </thead>
                <Table.TBody>
                  <tr>
                    {Object.entries(cacheData.dnsCache?.stats ?? {})
                      .filter(([statName]) => statName !== 'maxSize')
                      .map(([statName, statValue]) => (
                        <Table.TD key={`dns-stat-${statName}`}>
                          {statName === 'hitRate'
                            ? intl.formatNumber(statValue, {
                                style: 'percent',
                                maximumFractionDigits: 2,
                              })
                            : intl.formatNumber(statValue)}
                        </Table.TD>
                      ))}
                  </tr>
                </Table.TBody>
              </Table>
            )}
          </div>
        </>
      )}
      <div className="break-words">
        <h3 className="heading">{intl.formatMessage(messages.imagecache)}</h3>
        <p className="description">
          {intl.formatMessage(messages.imagecacheDescription, {
            code: (msg: React.ReactNode) => (
              <code key="code-block" className="bg-gray-800/50">
                {msg}
              </code>
            ),
            appDataPath: appData ? appData.appDataPath : '/app/config',
          })}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.cachename)}</Table.TH>
              <Table.TH>
                {intl.formatMessage(messages.imagecachecount)}
              </Table.TH>
              <Table.TH>{intl.formatMessage(messages.imagecachesize)}</Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            <tr>
              <Table.TD>The Movie Database (tmdb)</Table.TD>
              <Table.TD>
                {intl.formatNumber(cacheData?.imageCache.tmdb.imageCount ?? 0)}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.tmdb.size ?? 0)}
              </Table.TD>
            </tr>
            <tr>
              <Table.TD>
                {intl.formatMessage(messages.usersavatars)} (avatar)
              </Table.TD>
              <Table.TD>
                {intl.formatNumber(
                  cacheData?.imageCache.avatar.imageCount ?? 0
                )}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.avatar.size ?? 0)}
              </Table.TD>
            </tr>
          </Table.TBody>
        </Table>
      </div>
    </>
  );
};

export default SettingsJobs;
