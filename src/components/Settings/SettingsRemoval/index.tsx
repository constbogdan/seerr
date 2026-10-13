import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Tooltip from '@app/components/Common/Tooltip';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import RemovalPolicyEditor, {
  type RemovalPreviewPool,
} from '@app/components/Settings/SettingsRemoval/RemovalPolicyEditor';
import {
  newlyEnabledRemovalPolicies,
  normalizeRemovalThresholds,
  revertNewlyEnabledRemovalPolicies,
} from '@app/components/Settings/SettingsRemoval/helpers';
import {
  currentRemovalPreview,
  isCurrentRemovalPreviewRequest,
  reconcileRemovalDraft,
  removalSettingsEqual,
  removalSettingsFingerprint,
  type RemovalPreviewIdentity,
} from '@app/components/Settings/SettingsRemoval/state';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { InformationCircleIcon } from '@heroicons/react/24/solid';
import type { RemovalSettings } from '@server/constants/removal';
import axios from 'axios';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const REMOVAL_DELAY_OPTIONS = [10, 20, 30, 60, 90] as const;

const messages = defineMessages('components.Settings.SettingsRemoval', {
  title: 'Removal Settings',
  description:
    'Configure automatic removal rules and scheduled removal behavior.',
  advancedTooltip: 'Job frequency and manual runs are managed in Jobs & Cache.',
  countdownLabel: 'Removal Grace Period',
  countdownDescription: 'Time between scheduling an item and removing it.',
  dayUnit: '{count, plural, one {day} other {days}}',
  removalScanEnabled: 'Removal Scan',
  removalScanDescription:
    'Automatically scan for eligible Movies and Series and schedule a new batch.',
  removalProcessingEnabled: 'Removal Processing',
  removalProcessingDescription:
    'Automatically process items when their scheduled removal date is reached.',
  movies: 'Movies',
  series: 'Series',
  loadFailed: 'Unable to load Removal settings.',
  previewFailed: 'Unable to calculate the eligibility preview.',
  previewRetry: 'Retry preview',
  save: 'Save changes',
  saving: 'Saving…',
  saved: 'Removal settings saved.',
  saveFailed: 'Unable to save Removal settings.',
  saveRefreshFailed:
    'Removal settings were saved, but the latest server state could not be refreshed.',
  remoteChangeTitle: 'Removal settings changed on the server',
  remoteChangeDescription:
    'Choose whether to load the server settings or continue with your unsaved edits.',
  useServerSettings: 'Use server settings',
  keepMyEdits: 'Keep my edits',
  runFailed: 'Removal operation failed.',
  clearDescription: 'Cancels all pending removals. No media is removed.',
  clearItems: 'Clear {count, plural, one {# item} other {# items}}',
  clearing: 'Clearing…',
  clearTitle: 'Clear scheduled items?',
  clearConfirmation:
    'This will cancel all pending Movie, Series, and Season removal schedules and clear Leaving Soon. No media will be removed.',
  clearCompleted:
    '{count, plural, =0 {No actionable schedules existed.} one {# actionable schedule was cancelled.} other {# actionable schedules were cancelled.}}',
  enableMovieTitle: 'Enable automatic Movie scheduling?',
  enableSeriesTitle: 'Enable automatic Series scheduling?',
  enableBothTitle: 'Enable automatic Movie and Series scheduling?',
  enableConsequence:
    '{count} {media} currently qualify.\nUp to {selected} would enter Leaving Soon on the next scan.',
  enableDelay: 'Removal delay: {days} days.',
  enableBehavior:
    'Removal Scan creates countdown schedules; it does not immediately remove media. Activity during the countdown cancels the schedule when Removal Processing runs.',
});

interface RemovalPreview {
  actionableScheduleCount: number;
  movie: RemovalPreviewPool;
  series: RemovalPreviewPool;
}

const SettingsRemoval = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<RemovalSettings>(
    '/api/v1/settings/removal'
  );
  const [values, setValues] = useState<RemovalSettings | null>(null);
  const [savedValues, setSavedValues] = useState<RemovalSettings | null>(null);
  const [remoteValues, setRemoteValues] = useState<RemovalSettings | null>(
    null
  );
  const [previewState, setPreviewState] =
    useState<RemovalPreviewIdentity<RemovalPreview> | null>(null);
  const [previewingFingerprint, setPreviewingFingerprint] = useState<
    string | null
  >(null);
  const [previewErrorFingerprint, setPreviewErrorFingerprint] = useState<
    string | null
  >(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [showClearConfirmation, setShowClearConfirmation] = useState(false);
  const [clearPreviewFingerprint, setClearPreviewFingerprint] = useState<
    string | null
  >(null);
  const [clearing, setClearing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const valuesRef = useRef<RemovalSettings | null>(null);
  const savedValuesRef = useRef<RemovalSettings | null>(null);
  const previewRequestRef = useRef(0);
  const saveRequestRef = useRef(false);
  const clearRequestRef = useRef(false);
  const mountedRef = useRef(true);
  const updateValues = useCallback((next: RemovalSettings) => {
    valuesRef.current = next;
    setValues(next);
  }, []);

  const updateSavedValues = useCallback((next: RemovalSettings) => {
    savedValuesRef.current = next;
    setSavedValues(next);
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      previewRequestRef.current += 1;
      saveRequestRef.current = false;
      clearRequestRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!data) return;
    const reconciliation = reconcileRemovalDraft(
      data,
      savedValuesRef.current,
      valuesRef.current
    );
    if (reconciliation.type === 'unchanged') return;

    previewRequestRef.current += 1;
    setPreviewState(null);
    setPreviewErrorFingerprint(null);
    setPreviewingFingerprint(null);
    setPreviewRetry((current) => current + 1);

    if (reconciliation.type === 'remote-conflict') {
      setRemoteValues(reconciliation.settings);
      return;
    }

    updateSavedValues(reconciliation.settings);
    updateValues(reconciliation.settings);
    setRemoteValues(null);
  }, [data, updateSavedValues, updateValues]);

  useEffect(() => {
    if (!values) return;
    const fingerprint = removalSettingsFingerprint(values);
    const requestId = ++previewRequestRef.current;
    const timeout = setTimeout(() => {
      setPreviewingFingerprint(fingerprint);
      setPreviewErrorFingerprint(null);
      void axios
        .post<RemovalPreview>('/api/v1/settings/removal/preview', values)
        .then((response) => {
          const currentValues = valuesRef.current;
          if (
            !mountedRef.current ||
            currentValues === null ||
            !isCurrentRemovalPreviewRequest(
              requestId,
              previewRequestRef.current,
              fingerprint,
              currentValues
            )
          ) {
            return;
          }
          const normalized = normalizeRemovalThresholds(
            currentValues,
            response.data
          );
          if (!removalSettingsEqual(normalized, currentValues)) {
            updateValues(normalized);
            return;
          }
          setPreviewState({ fingerprint, value: response.data });
        })
        .catch(() => {
          if (
            mountedRef.current &&
            isCurrentRemovalPreviewRequest(
              requestId,
              previewRequestRef.current,
              fingerprint,
              valuesRef.current
            )
          ) {
            setPreviewErrorFingerprint(fingerprint);
          }
        })
        .finally(() => {
          if (mountedRef.current && requestId === previewRequestRef.current) {
            setPreviewingFingerprint((current) =>
              current === fingerprint ? null : current
            );
          }
        });
    }, 400);
    return () => {
      clearTimeout(timeout);
    };
  }, [previewRetry, updateValues, values]);

  if (!values && !error) return <LoadingSpinner />;
  if (!values) {
    return (
      <div className="text-red-400">
        {intl.formatMessage(messages.loadFailed)}
      </div>
    );
  }

  const valuesFingerprint = removalSettingsFingerprint(values);
  const preview = currentRemovalPreview(previewState, values);
  const previewing = previewingFingerprint === valuesFingerprint;
  const previewError = previewErrorFingerprint === valuesFingerprint;
  const previewIsActionable = Boolean(
    preview && !previewing && !previewError && !remoteValues
  );
  const clearPreviewIsCurrent = Boolean(
    previewIsActionable && clearPreviewFingerprint === valuesFingerprint
  );
  const dirty = Boolean(
    savedValues && !removalSettingsEqual(savedValues, values)
  );

  const automaticEnableConfirmation = (
    keys: ('movie' | 'series')[],
    currentPreview: RemovalPreview
  ) => {
    const title = intl.formatMessage(
      keys.length === 2
        ? messages.enableBothTitle
        : keys[0] === 'movie'
          ? messages.enableMovieTitle
          : messages.enableSeriesTitle
    );
    const consequences = keys.map((key) =>
      intl.formatMessage(messages.enableConsequence, {
        count: currentPreview[key].eligibleUnscheduled,
        media: intl.formatMessage(
          key === 'movie' ? messages.movies : messages.series
        ),
        selected: currentPreview[key].candidates.length,
      })
    );
    return [
      title,
      '',
      ...consequences,
      '',
      intl.formatMessage(messages.enableDelay, {
        days: values.removalDelayDays,
      }),
      '',
      intl.formatMessage(messages.enableBehavior),
    ].join('\n');
  };

  const clearScheduledItems = async () => {
    if (
      clearRequestRef.current ||
      !clearPreviewIsCurrent ||
      !preview ||
      preview.actionableScheduleCount === 0
    ) {
      return;
    }
    clearRequestRef.current = true;
    setClearing(true);
    try {
      const response = await axios.post<{ cancelled: number }>(
        '/api/v1/settings/removal/clear'
      );
      const message = intl.formatMessage(messages.clearCompleted, {
        count: response.data.cancelled,
      });
      if (!mountedRef.current) return;
      setPreviewState((current) =>
        current?.fingerprint === valuesFingerprint
          ? {
              ...current,
              value: { ...current.value, actionableScheduleCount: 0 },
            }
          : current
      );
      setResult(message);
      setShowClearConfirmation(false);
      setClearPreviewFingerprint(null);
      addToast(message, { appearance: 'success', autoDismiss: true });
    } catch {
      if (!mountedRef.current) return;
      addToast(intl.formatMessage(messages.runFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      clearRequestRef.current = false;
      if (mountedRef.current) setClearing(false);
    }
  };

  const saveSettings = async () => {
    if (saveRequestRef.current || remoteValues) return;
    saveRequestRef.current = true;
    setSaving(true);
    const submittedValues = values;
    const submittedFingerprint = removalSettingsFingerprint(submittedValues);
    let saved = false;
    try {
      if (!savedValues) return;
      const newlyEnabled = newlyEnabledRemovalPolicies(
        savedValues,
        submittedValues
      );
      const scanEnabling =
        !savedValues.removalScanEnabled && submittedValues.removalScanEnabled;
      if (newlyEnabled.length > 0 || scanEnabling) {
        const response = await axios.post<RemovalPreview>(
          '/api/v1/settings/removal/preview',
          submittedValues
        );
        if (!mountedRef.current) return;
        if (
          valuesRef.current &&
          removalSettingsFingerprint(valuesRef.current) === submittedFingerprint
        ) {
          setPreviewState({
            fingerprint: submittedFingerprint,
            value: response.data,
          });
        }
        const keys = scanEnabling
          ? (['movie', 'series'] as const)
          : newlyEnabled;
        if (
          !window.confirm(automaticEnableConfirmation([...keys], response.data))
        ) {
          if (
            valuesRef.current &&
            removalSettingsFingerprint(valuesRef.current) ===
              submittedFingerprint
          ) {
            updateValues({
              ...revertNewlyEnabledRemovalPolicies(
                submittedValues,
                newlyEnabled
              ),
              removalScanEnabled: scanEnabling
                ? false
                : submittedValues.removalScanEnabled,
            });
          }
          return;
        }
      }

      const response = await axios.post<RemovalSettings>(
        '/api/v1/settings/removal',
        submittedValues
      );
      saved = true;
      if (!mountedRef.current) return;
      updateSavedValues(response.data);
      setRemoteValues(null);
      if (
        valuesRef.current &&
        removalSettingsFingerprint(valuesRef.current) === submittedFingerprint
      ) {
        updateValues(response.data);
      }
      await mutate(response.data, false);
      if (!mountedRef.current) return;
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
      try {
        const refreshed = await mutate();
        if (!refreshed) {
          throw new Error('Removal settings refresh returned no data.');
        }
      } catch {
        if (mountedRef.current) {
          addToast(intl.formatMessage(messages.saveRefreshFailed), {
            appearance: 'error',
            autoDismiss: false,
          });
        }
      }
    } catch {
      if (mountedRef.current) {
        addToast(
          intl.formatMessage(
            saved ? messages.saveRefreshFailed : messages.saveFailed
          ),
          {
            appearance: 'error',
            autoDismiss: !saved,
          }
        );
      }
    } finally {
      saveRequestRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <Transition
        as={Fragment}
        show={showClearConfirmation}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          title={intl.formatMessage(messages.clearTitle)}
          okText={
            clearing
              ? intl.formatMessage(messages.clearing)
              : intl.formatMessage(messages.clearItems, {
                  count: preview?.actionableScheduleCount ?? 0,
                })
          }
          okButtonType="danger"
          okDisabled={
            clearing ||
            !clearPreviewIsCurrent ||
            (preview?.actionableScheduleCount ?? 0) === 0
          }
          onOk={clearScheduledItems}
          cancelText={intl.formatMessage(globalMessages.cancel)}
          cancelButtonProps={{ disabled: clearing }}
          backgroundClickable={!clearing}
          onCancel={() => {
            if (!clearing) {
              setShowClearConfirmation(false);
              setClearPreviewFingerprint(null);
            }
          }}
        >
          {intl.formatMessage(messages.clearConfirmation)}
        </Modal>
      </Transition>
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
          <SettingsBadge
            badgeType="advanced"
            tooltip={intl.formatMessage(messages.advancedTooltip)}
          />
        </div>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      {remoteValues && (
        <Alert
          type="warning"
          title={intl.formatMessage(messages.remoteChangeTitle)}
        >
          <p>{intl.formatMessage(messages.remoteChangeDescription)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              buttonSize="sm"
              onClick={() => {
                updateSavedValues(remoteValues);
                updateValues(remoteValues);
                setRemoteValues(null);
                setResult(null);
                setPreviewRetry((current) => current + 1);
              }}
            >
              {intl.formatMessage(messages.useServerSettings)}
            </Button>
            <Button
              buttonSize="sm"
              buttonType="warning"
              onClick={() => {
                updateSavedValues(remoteValues);
                setRemoteValues(null);
                setPreviewRetry((current) => current + 1);
              }}
            >
              {intl.formatMessage(messages.keepMyEdits)}
            </Button>
          </div>
        </Alert>
      )}

      <section className="section">
        <div className="form-row">
          <div className="sm:mt-1">
            <span className="block text-sm font-bold leading-5 text-gray-400">
              {intl.formatMessage(messages.removalProcessingEnabled)}
            </span>
            <span className="label-tip">
              {intl.formatMessage(messages.removalProcessingDescription)}
            </span>
          </div>
          <div className="form-input-area">
            <SlideCheckbox
              ariaLabel={intl.formatMessage(messages.removalProcessingEnabled)}
              checked={values.removalProcessingEnabled}
              onClick={() =>
                updateValues({
                  ...values,
                  removalProcessingEnabled: !values.removalProcessingEnabled,
                })
              }
            />
          </div>
        </div>

        <div className="form-row">
          <div className="sm:mt-1">
            <span className="block text-sm font-bold leading-5 text-gray-400">
              {intl.formatMessage(messages.removalScanEnabled)}
            </span>
            <span className="label-tip">
              {intl.formatMessage(messages.removalScanDescription)}
            </span>
          </div>
          <div className="form-input-area">
            <SlideCheckbox
              ariaLabel={intl.formatMessage(messages.removalScanEnabled)}
              checked={values.removalScanEnabled}
              onClick={() =>
                updateValues({
                  ...values,
                  removalScanEnabled: !values.removalScanEnabled,
                })
              }
            />
          </div>
        </div>

        <div className="form-row">
          <label htmlFor="removalDelayDays" className="text-label">
            <span>{intl.formatMessage(messages.countdownLabel)}</span>
            <span className="label-tip">
              {intl.formatMessage(messages.countdownDescription)}
            </span>
          </label>
          <div className="form-input-area">
            <select
              id="removalDelayDays"
              className="short"
              value={values.removalDelayDays}
              onChange={(event) =>
                updateValues({
                  ...values,
                  removalDelayDays: Number(event.target.value),
                })
              }
            >
              {REMOVAL_DELAY_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  {days} {intl.formatMessage(messages.dayUnit, { count: days })}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="border-t border-gray-700 pt-6">
        {previewError && (
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-red-400">
            <span>{intl.formatMessage(messages.previewFailed)}</span>
            <Button
              buttonSize="sm"
              onClick={() => {
                setPreviewState(null);
                setPreviewErrorFingerprint(null);
                setPreviewRetry((current) => current + 1);
              }}
            >
              {intl.formatMessage(messages.previewRetry)}
            </Button>
          </div>
        )}
        <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-[minmax(0,27.25rem)] xl:grid-cols-[repeat(2,minmax(0,27.25rem))]">
          <RemovalPolicyEditor
            title={intl.formatMessage(messages.movies)}
            policy={values.movie}
            preview={preview?.movie ?? null}
            previewing={previewing}
            onChange={(movie) => updateValues({ ...values, movie })}
          />
          <RemovalPolicyEditor
            title={intl.formatMessage(messages.series)}
            policy={values.series}
            preview={preview?.series ?? null}
            previewing={previewing}
            onChange={(series) => updateValues({ ...values, series })}
          />
        </div>
      </section>

      {result && (
        <p className="mt-4 text-right text-sm text-gray-200">{result}</p>
      )}
      <div className="actions">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2">
            <Tooltip content={intl.formatMessage(messages.clearDescription)}>
              <Badge
                badgeType="warning"
                className="h-6 w-6 items-center justify-center !px-0"
              >
                <InformationCircleIcon className="h-4 w-4" aria-hidden />
                <span className="sr-only">
                  {intl.formatMessage(messages.clearDescription)}
                </span>
              </Badge>
            </Tooltip>
            <Button
              buttonType="danger"
              disabled={
                clearing ||
                saving ||
                !previewIsActionable ||
                (preview?.actionableScheduleCount ?? 0) === 0
              }
              onClick={() => {
                if (!previewIsActionable) return;
                setClearPreviewFingerprint(valuesFingerprint);
                setShowClearConfirmation(true);
              }}
            >
              {clearing
                ? intl.formatMessage(messages.clearing)
                : intl.formatMessage(messages.clearItems, {
                    count: preview?.actionableScheduleCount ?? 0,
                  })}
            </Button>
          </div>
          <Button
            buttonType="primary"
            disabled={clearing || saving || Boolean(remoteValues) || !dirty}
            onClick={() => void saveSettings()}
          >
            {intl.formatMessage(saving ? messages.saving : messages.save)}
          </Button>
        </div>
      </div>
    </>
  );
};

export default SettingsRemoval;
