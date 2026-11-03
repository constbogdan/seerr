import Alert from '@app/components/Common/Alert';
import defineMessages from '@app/utils/defineMessages';
import type { SynchronizationContainmentStatus as SynchronizationContainmentStatusResponse } from '@server/interfaces/api/settingsInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SynchronizationContainmentStatus',
  {
    verifying: 'Verifying synchronization mode',
    unavailable: 'Synchronization mode could not be verified',
    unavailableDescription:
      'Do not assume synchronization is contained until the administrator status API is available.',
    normal: 'Synchronization mode: Normal',
    normalDescription:
      'Startup catch-ups, schedules and administrator-triggered synchronization are active.',
    contained: 'Synchronization mode: Contained',
    containedDescription:
      'Startup catch-ups, schedules and manual synchronization are blocked. A restart is required to change modes.',
    commissioning: 'Synchronization mode: Commissioning',
    commissioningDescription:
      'Automatic synchronization is blocked. Manual synchronization must follow the required commissioning order.',
    nextJob: 'Next required job: {jobId}',
    activeJob: 'Active commissioning job: {jobId}',
    complete: 'The commissioning sequence is complete.',
  }
);

const SynchronizationContainmentStatus = () => {
  const intl = useIntl();
  const { data, error } = useSWR<SynchronizationContainmentStatusResponse>(
    '/api/v1/settings/synchronization-containment',
    { refreshInterval: 5000 }
  );

  if (error) {
    return (
      <div role="alert">
        <Alert type="error" title={intl.formatMessage(messages.unavailable)}>
          {intl.formatMessage(messages.unavailableDescription)}
        </Alert>
      </div>
    );
  }

  if (!data) {
    return (
      <div role="status">
        <Alert type="info" title={intl.formatMessage(messages.verifying)} />
      </div>
    );
  }

  const title =
    data.mode === 'normal'
      ? messages.normal
      : data.mode === 'contained'
        ? messages.contained
        : messages.commissioning;
  const description =
    data.mode === 'normal'
      ? messages.normalDescription
      : data.mode === 'contained'
        ? messages.containedDescription
        : messages.commissioningDescription;
  const commissioning = data.commissioning;

  return (
    <div role="status" aria-live="polite">
      <Alert
        type={data.mode === 'normal' ? 'info' : 'warning'}
        title={intl.formatMessage(title)}
      >
        <p>{intl.formatMessage(description)}</p>
        {commissioning?.activeJobId ? (
          <p className="mt-1">
            {intl.formatMessage(messages.activeJob, {
              jobId: commissioning.activeJobId,
            })}
          </p>
        ) : commissioning?.nextRequiredJobId ? (
          <p className="mt-1">
            {intl.formatMessage(messages.nextJob, {
              jobId: commissioning.nextRequiredJobId,
            })}
          </p>
        ) : commissioning ? (
          <p className="mt-1">{intl.formatMessage(messages.complete)}</p>
        ) : null}
      </Alert>
    </div>
  );
};

export default SynchronizationContainmentStatus;
