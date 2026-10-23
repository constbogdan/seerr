import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type { JobId } from '@server/lib/settings';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsNextSeason', {
  title: 'Next Season',
  description:
    'Automatically request each next regular Season when a viewer has watched at least 70% of a physically present Season.',
  enable: 'Enable Next Season automation',
  enableDescription:
    'Runs independently every five minutes and uses the latest saved Library viewing progress.',
  requestOwner:
    'Automatic requests use the administrator configured as the Watchlist Roulette request owner.',
  dryRun: 'Dry Run',
  dryRunDescription:
    'Evaluate current Library progress and request eligibility without creating requests or starting downloads.',
  dryRunComplete:
    'Dry run complete: {seriesExamined} Series examined, {qualifyingProgress} qualifying viewers, {requested} would be requested, {skipped} skipped, and {failed} failed.',
  enabled: 'Next Season automation enabled.',
  disabled: 'Next Season automation disabled.',
  updateFailed: 'Unable to update Next Season automation: {message}',
  dryRunFailed: 'Unable to complete the Next Season dry run: {message}',
  loadFailed: 'Unable to load Next Season settings.',
  retry: 'Retry',
});

interface NextSeasonJob {
  id: JobId;
  enabled: boolean;
  configurableEnabled: boolean;
  running: boolean;
}

interface NextSeasonRunSummary {
  seriesExamined: number;
  qualifyingProgress: number;
  skipped: number;
  failed: number;
  candidates: { outcome: string }[];
}

const errorMessage = (error: unknown, fallback: string): string =>
  axios.isAxiosError(error) && typeof error.response?.data?.message === 'string'
    ? error.response.data.message
    : fallback;

const SettingsNextSeason = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<NextSeasonJob[]>(
    '/api/v1/settings/jobs'
  );
  const [updating, setUpdating] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const job = data?.find((candidate) => candidate.id === 'next-season');

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

  const dryRun = async () => {
    if (dryRunning) return;
    setDryRunning(true);
    try {
      const response = await axios.post<NextSeasonRunSummary>(
        '/api/v1/settings/jobs/next-season/dry-run'
      );
      addToast(
        intl.formatMessage(messages.dryRunComplete, {
          seriesExamined: response.data.seriesExamined,
          qualifyingProgress: response.data.qualifyingProgress,
          requested: response.data.candidates.filter(
            (candidate) => candidate.outcome === 'would-request'
          ).length,
          skipped: response.data.skipped,
          failed: response.data.failed,
        }),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
    } catch (dryRunError) {
      addToast(
        intl.formatMessage(messages.dryRunFailed, {
          message: errorMessage(
            dryRunError,
            intl.formatMessage(messages.loadFailed)
          ),
        }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setDryRunning(false);
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
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      <div className="form-row">
        <div className="text-label">{intl.formatMessage(messages.enable)}</div>
        <div className="form-input">
          <SlideCheckbox
            checked={job.enabled}
            disabled={updating || !job.configurableEnabled}
            ariaLabel={intl.formatMessage(messages.enable)}
            onClick={() => void setEnabled(!job.enabled)}
          />
          <p className="mt-2 text-sm text-gray-400">
            {intl.formatMessage(messages.enableDescription)}
          </p>
          <p className="mt-2 text-sm text-gray-400">
            {intl.formatMessage(messages.requestOwner)}
          </p>
        </div>
      </div>

      <div className="form-row">
        <div className="text-label">{intl.formatMessage(messages.dryRun)}</div>
        <div className="form-input">
          <Button
            buttonType="primary"
            disabled={dryRunning || job.running}
            onClick={() => void dryRun()}
          >
            {intl.formatMessage(messages.dryRun)}
          </Button>
          <p className="mt-2 text-sm text-gray-400">
            {intl.formatMessage(messages.dryRunDescription)}
          </p>
        </div>
      </div>
    </div>
  );
};

export default SettingsNextSeason;
