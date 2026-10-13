import Button from '@app/components/Common/Button';
import SynchronizationContainmentStatus from '@app/components/Settings/SynchronizationContainmentStatus';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useState } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsHistoryImport', {
  title: 'Import historical data',
  description:
    'Validate and merge a supported Wholphin history file into the factual Foundation. Current Jellyfin state is never replaced by this import. The observed date range does not assert exhaustive historical completeness.',
  file: 'Historical-data file',
  validate: 'Validate',
  import: 'Import',
  rejected: 'The historical-data file was rejected.',
  rejectedWithDisposition:
    'The historical-data file was rejected: {disposition}.',
  noAcceptedImport: 'No accepted historical import',
  unknownStart: 'Unknown start',
  unknownEnd: 'Unknown end',
  range: '{start} – {end}',
  disposition: 'Disposition: {disposition}',
  observedRange: 'Observed historical range: {range}',
  acceptedRange: 'Accepted observed range: {range}',
  completeness: 'Historical completeness: not asserted',
  completenessShort: '(completeness not asserted)',
  dispositionFirstImport: 'first import',
  dispositionExactRepeat: 'exact repeat',
  dispositionRepair: 'repair',
  dispositionAdditiveCumulative: 'additive cumulative import',
  dispositionCorrectedFacts: 'corrected facts',
  dispositionRegressiveArtifact: 'regressive artifact',
  dispositionHistoricalOmission: 'historical omission',
  countViewers: 'viewers',
  countMedia: 'media',
  countSeasons: 'seasons',
  countEpisodes: 'episodes',
  countLibraryFacts: 'library facts',
  countViewingFacts: 'viewing facts',
  countCompletionFacts: 'completion facts',
  countActivityFacts: 'activity facts',
  countUntimedEvidenceFacts: 'untimed evidence facts',
  count: '{label}: {count, number}',
});

interface ObservedRange {
  startedAt: string | null;
  endedAt: string | null;
  completeness: 'not-asserted';
}

interface ValidationResult {
  valid: boolean;
  importable: boolean;
  disposition: string;
  schema: string;
  datasetId: string;
  contentHash: string;
  counts: Record<string, number>;
  observedRange: ObservedRange;
  acceptedObservedRange: ObservedRange | null;
  comparison: {
    exactFacts: number;
    missingFacts: number;
    correctedFacts: number;
    omittedFacts: number;
  };
}

interface ImportCapabilities {
  status: {
    state: 'not-imported' | 'accepted';
    observedRange: ObservedRange | null;
    contentHash: string | null;
  };
}

const formatRange = (intl: IntlShape, value: ObservedRange | null) => {
  if (!value) return intl.formatMessage(messages.noAcceptedImport);
  const start = value.startedAt
    ? intl.formatDate(value.startedAt, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : intl.formatMessage(messages.unknownStart);
  const end = value.endedAt
    ? intl.formatDate(value.endedAt, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : intl.formatMessage(messages.unknownEnd);
  return intl.formatMessage(messages.range, { start, end });
};

const dispositionMessages = {
  'first-import': messages.dispositionFirstImport,
  'exact-repeat': messages.dispositionExactRepeat,
  repair: messages.dispositionRepair,
  'additive-cumulative': messages.dispositionAdditiveCumulative,
  'corrected-facts': messages.dispositionCorrectedFacts,
  'regressive-artifact': messages.dispositionRegressiveArtifact,
  'historical-omission': messages.dispositionHistoricalOmission,
};

const countMessages = {
  viewers: messages.countViewers,
  media: messages.countMedia,
  seasons: messages.countSeasons,
  episodes: messages.countEpisodes,
  libraryFacts: messages.countLibraryFacts,
  viewingFacts: messages.countViewingFacts,
  completionFacts: messages.countCompletionFacts,
  activityFacts: messages.countActivityFacts,
  untimedEvidenceFacts: messages.countUntimedEvidenceFacts,
};

const SettingsHistoryImport = () => {
  const intl = useIntl();
  const { data: capabilities, mutate } = useSWR<ImportCapabilities>(
    '/api/v1/settings/history-import'
  );
  const [file, setFile] = useState<File>();
  const [validation, setValidation] = useState<ValidationResult>();
  const [result, setResult] = useState<Record<string, unknown>>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (endpoint: string) => {
    if (!file) return;
    setBusy(true);
    setMessage('');
    try {
      const body = await file.arrayBuffer();
      const response = await axios.post(endpoint, body, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      return response.data;
    } catch (error) {
      const disposition = axios.isAxiosError(error)
        ? error.response?.data?.inspection?.disposition
        : undefined;
      setMessage(
        disposition
          ? intl.formatMessage(messages.rejectedWithDisposition, {
              disposition:
                dispositionMessages[
                  disposition as keyof typeof dispositionMessages
                ] !== undefined
                  ? intl.formatMessage(
                      dispositionMessages[
                        disposition as keyof typeof dispositionMessages
                      ]
                    )
                  : disposition,
            })
          : intl.formatMessage(messages.rejected)
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
      <p className="description">{intl.formatMessage(messages.description)}</p>
      <SynchronizationContainmentStatus />
      <div className="section">
        <div className="form-row">
          <label className="text-label" htmlFor="historyFile">
            {intl.formatMessage(messages.file)}
          </label>
          <div className="form-input-area">
            <input
              id="historyFile"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setValidation(undefined);
                setResult(undefined);
                setMessage('');
              }}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={!file || busy}
            onClick={async () => {
              const value = await send(
                '/api/v1/settings/history-import/validate'
              );
              if (value) setValidation(value as ValidationResult);
            }}
          >
            {intl.formatMessage(messages.validate)}
          </Button>
          <Button
            buttonType="primary"
            disabled={!file || !validation?.importable || busy}
            onClick={async () => {
              const value = await send('/api/v1/settings/history-import');
              if (value) {
                setResult(value as Record<string, unknown>);
                await mutate();
              }
            }}
          >
            {intl.formatMessage(messages.import)}
          </Button>
        </div>
        {validation && (
          <div className="mt-4 rounded-md bg-gray-800 p-4 text-sm">
            <div>{validation.schema}</div>
            <div className="mt-1 capitalize">
              {intl.formatMessage(messages.disposition, {
                disposition:
                  dispositionMessages[
                    validation.disposition as keyof typeof dispositionMessages
                  ] !== undefined
                    ? intl.formatMessage(
                        dispositionMessages[
                          validation.disposition as keyof typeof dispositionMessages
                        ]
                      )
                    : validation.disposition,
              })}
            </div>
            <div className="break-all text-gray-400">
              {validation.contentHash}
            </div>
            <div className="mt-2">
              {intl.formatMessage(messages.observedRange, {
                range: formatRange(intl, validation.observedRange),
              })}
            </div>
            <div className="text-gray-400">
              {intl.formatMessage(messages.completeness)}
            </div>
            <div className="mt-2">
              {Object.entries(validation.counts)
                .map(([label, count]) =>
                  intl.formatMessage(messages.count, {
                    label:
                      countMessages[label as keyof typeof countMessages] !==
                      undefined
                        ? intl.formatMessage(
                            countMessages[label as keyof typeof countMessages]
                          )
                        : label,
                    count,
                  })
                )
                .join(' · ')}
            </div>
          </div>
        )}
        {capabilities?.status.state === 'accepted' && (
          <div className="mt-4 text-sm text-gray-300">
            {intl.formatMessage(messages.acceptedRange, {
              range: formatRange(intl, capabilities.status.observedRange),
            })}
            <span className="ml-2 text-gray-400">
              {intl.formatMessage(messages.completenessShort)}
            </span>
          </div>
        )}
        {result && (
          <pre className="mt-4 overflow-auto rounded-md bg-gray-800 p-4 text-xs">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
        {message && <p className="mt-3 text-red-400">{message}</p>}
      </div>
    </>
  );
};

export default SettingsHistoryImport;
