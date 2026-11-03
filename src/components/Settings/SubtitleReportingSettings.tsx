import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import defineMessages from '@app/utils/defineMessages';
import { getSubtitleReportingOrigin } from '@server/lib/settings/subtitleReporting';
import { useIntl } from 'react-intl';

export const subtitleReportingMessages = defineMessages(
  'components.Settings.SubtitleReporting',
  {
    heading: 'Subtitle Issue Reporting',
    enabled: 'Enable Subtitle Reporting',
    origin: 'Jellyfin Web Origin',
    originDescription:
      'Uses the HTTPS origin of the External URL above. Reports require an existing linked account with issue permissions.',
    notConfigured: 'Not configured',
    invalidOrigin:
      'Subtitle reporting requires an HTTPS External URL without credentials, query or fragment.',
  }
);

export default function SubtitleReportingSettings({
  enabled = false,
  externalUrl,
  disabled = false,
  onChange,
}: {
  enabled?: boolean;
  externalUrl: string;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const intl = useIntl();
  return (
    <section aria-labelledby="subtitle-reporting-heading">
      <h4 id="subtitle-reporting-heading" className="heading mb-4 mt-8">
        {intl.formatMessage(subtitleReportingMessages.heading)}
      </h4>
      <div className="form-row">
        <span className="checkbox-label">
          {intl.formatMessage(subtitleReportingMessages.enabled)}
        </span>
        <div className="form-input-area">
          <SlideCheckbox
            checked={enabled}
            disabled={disabled}
            ariaLabel={intl.formatMessage(subtitleReportingMessages.enabled)}
            onClick={() => onChange(!enabled)}
          />
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="subtitle-reporting-origin" className="text-label">
          {intl.formatMessage(subtitleReportingMessages.origin)}
        </label>
        <div className="form-input-area">
          <div className="form-input-field">
            <input
              id="subtitle-reporting-origin"
              type="text"
              readOnly
              value={getSubtitleReportingOrigin(externalUrl) ?? ''}
              placeholder={intl.formatMessage(
                subtitleReportingMessages.notConfigured
              )}
              aria-describedby="subtitle-reporting-origin-description"
            />
          </div>
          <p
            id="subtitle-reporting-origin-description"
            className="mt-2 text-sm text-gray-400"
          >
            {intl.formatMessage(subtitleReportingMessages.originDescription)}
          </p>
        </div>
      </div>
    </section>
  );
}
