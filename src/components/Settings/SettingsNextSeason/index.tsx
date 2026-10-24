import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Table from '@app/components/Common/Table';
import Tooltip from '@app/components/Common/Tooltip';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon } from '@heroicons/react/24/solid';
import type { JobId } from '@server/lib/settings';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

import {
  selectNextSeasonUpcomingRows,
  type NextSeasonUpcomingRow,
  type NextSeasonUpcomingSummary,
} from './upcoming';

const messages = defineMessages('components.Settings.SettingsNextSeason', {
  title: 'Next Season Automation',
  description:
    'Automatically request the next season when the current season viewing progress reaches 70% within the last 24 hours.',
  enable: 'Enable Next Season automation',
  upcoming: 'Upcoming',
  seriesSeason: 'Series / Season',
  user: 'User',
  lastWatched: 'Last watched',
  status: 'Status',
  eligible: 'Eligible',
  season: 'Season {seasonNumber}',
  noUpcoming: 'No upcoming Season requests.',
  upcomingLoading: 'Evaluating upcoming Season requests...',
  upcomingFailed: 'Unable to evaluate upcoming Season requests.',
  refresh: 'Refresh upcoming seasons',
  enabled: 'Next Season automation enabled.',
  disabled: 'Next Season automation disabled.',
  updateFailed: 'Unable to update Next Season automation: {message}',
  loadFailed: 'Unable to load Next Season settings.',
  retry: 'Retry',
});

interface NextSeasonJob {
  id: JobId;
  enabled: boolean;
  configurableEnabled: boolean;
  running: boolean;
}

const errorMessage = (error: unknown, fallback: string): string =>
  axios.isAxiosError(error) && typeof error.response?.data?.message === 'string'
    ? error.response.data.message
    : fallback;

export const NextSeasonUpcomingContent = ({
  loading,
  failed,
  rows,
}: {
  loading: boolean;
  failed: boolean;
  rows: NextSeasonUpcomingRow[];
}) => {
  const intl = useIntl();
  if (loading) {
    return (
      <p
        className="rounded-lg bg-gray-800 px-4 py-4 text-sm text-gray-400"
        role="status"
      >
        {intl.formatMessage(messages.upcomingLoading)}
      </p>
    );
  }
  if (failed) {
    return (
      <p
        className="rounded-lg bg-gray-800 px-4 py-4 text-sm text-red-400"
        role="alert"
      >
        {intl.formatMessage(messages.upcomingFailed)}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-lg bg-gray-800 px-4 py-4 text-sm text-gray-400">
        {intl.formatMessage(messages.noUpcoming)}
      </p>
    );
  }
  return (
    <Table>
      <thead>
        <tr>
          <Table.TH>{intl.formatMessage(messages.seriesSeason)}</Table.TH>
          <Table.TH>{intl.formatMessage(messages.user)}</Table.TH>
          <Table.TH>{intl.formatMessage(messages.lastWatched)}</Table.TH>
          <Table.TH>{intl.formatMessage(messages.status)}</Table.TH>
        </tr>
      </thead>
      <Table.TBody>
        {rows.map((row) => (
          <tr key={row.key}>
            <Table.TD>
              <Link
                href={row.href}
                className="font-medium text-white transition hover:text-indigo-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
              >
                {row.seriesTitle}
              </Link>
              <div className="text-xs text-gray-400">
                {intl.formatMessage(messages.season, {
                  seasonNumber: row.seasonNumber,
                })}
              </div>
            </Table.TD>
            <Table.TD className="text-gray-300">{row.viewer}</Table.TD>
            <Table.TD className="whitespace-nowrap text-gray-300">
              <time dateTime={row.lastWatchedAt}>
                {intl.formatDate(new Date(row.lastWatchedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </time>
            </Table.TD>
            <Table.TD className="whitespace-nowrap text-green-400">
              {intl.formatMessage(messages.eligible)}
            </Table.TD>
          </tr>
        ))}
      </Table.TBody>
    </Table>
  );
};

const SettingsNextSeason = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<NextSeasonJob[]>(
    '/api/v1/settings/jobs'
  );
  const [updating, setUpdating] = useState(false);
  const job = data?.find((candidate) => candidate.id === 'next-season');
  const {
    data: upcoming,
    error: upcomingError,
    isLoading: upcomingLoading,
    isValidating: upcomingRefreshing,
    mutate: refreshUpcoming,
  } = useSWR<NextSeasonUpcomingSummary>(
    '/api/v1/settings/jobs/next-season/dry-run',
    async (url: string) =>
      (await axios.post<NextSeasonUpcomingSummary>(url)).data,
    { revalidateOnFocus: false }
  );
  const upcomingRows = selectNextSeasonUpcomingRows(upcoming);
  const upcomingFailed =
    Boolean(upcomingError) ||
    (upcoming !== undefined &&
      (upcoming.status !== 'succeeded' || upcoming.failed > 0));

  const setEnabled = async (enabled: boolean) => {
    if (!job || updating) return;
    setUpdating(true);
    try {
      const response = await axios.post<NextSeasonJob>(
        '/api/v1/settings/jobs/next-season/enabled',
        { enabled }
      );
      await mutate(
        (current) =>
          current?.map((candidate) =>
            candidate.id === response.data.id
              ? { ...candidate, ...response.data }
              : candidate
          ),
        { revalidate: false }
      );
      addToast(
        intl.formatMessage(enabled ? messages.enabled : messages.disabled),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (updateError) {
      addToast(
        intl.formatMessage(messages.updateFailed, {
          message: errorMessage(
            updateError,
            intl.formatMessage(messages.loadFailed)
          ),
        }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setUpdating(false);
    }
  };

  if (!data && !error) return <LoadingSpinner />;

  if (error || !job) {
    return (
      <div className="section">
        <PageTitle title={intl.formatMessage(messages.title)} />
        <div className="mb-6">
          <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        </div>
        <p className="mb-4 text-red-400">
          {intl.formatMessage(messages.loadFailed)}
        </p>
        <Button buttonType="primary" onClick={() => void mutate()}>
          {intl.formatMessage(messages.retry)}
        </Button>
      </div>
    );
  }

  return (
    <div className="section">
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <h3 className="heading min-w-0">
            {intl.formatMessage(messages.title)}
          </h3>
          <div className="shrink-0">
            <SlideCheckbox
              checked={job.enabled}
              disabled={updating || !job.configurableEnabled}
              ariaLabel={intl.formatMessage(messages.enable)}
              onClick={() => void setEnabled(!job.enabled)}
            />
          </div>
        </div>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      <div className="mt-8">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-lg font-semibold text-white">
            {intl.formatMessage(messages.upcoming)}
          </h4>
          <Tooltip content={intl.formatMessage(messages.refresh)}>
            <Button
              className="h-[42px] w-[42px] !p-0"
              aria-label={intl.formatMessage(messages.refresh)}
              aria-busy={upcomingRefreshing}
              disabled={upcomingRefreshing || job.running}
              onClick={() => void refreshUpcoming()}
            >
              <ArrowPathIcon
                className={`h-5 w-5 ${
                  upcomingRefreshing
                    ? 'animate-spin motion-reduce:animate-none'
                    : ''
                }`}
                aria-hidden
              />
            </Button>
          </Tooltip>
        </div>
        <NextSeasonUpcomingContent
          loading={upcomingLoading}
          failed={upcomingFailed}
          rows={upcomingRows}
        />
      </div>
    </div>
  );
};

export default SettingsNextSeason;
