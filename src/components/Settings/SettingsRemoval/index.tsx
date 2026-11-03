import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Tooltip from '@app/components/Common/Tooltip';
import RemovalPolicyEditor, {
  type RemovalPreviewPool,
} from '@app/components/Settings/SettingsRemoval/RemovalPolicyEditor';
import { normalizeRemovalThresholds } from '@app/components/Settings/SettingsRemoval/helpers';
import {
  isCurrentRemovalPreviewRequest,
  reconcileRemovalDraft,
  removalPreviewFingerprint,
  removalPreviewPresentation,
  removalSettingsEqual,
  removalSettingsFingerprint,
  type RemovalPreviewIdentity,
} from '@app/components/Settings/SettingsRemoval/state';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
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
  const previewFingerprint = values ? removalPreviewFingerprint(values) : null;
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
    const proposedValues = valuesRef.current;
    if (!proposedValues || !previewFingerprint) return;
    const fingerprint = previewFingerprint;
    const requestId = ++previewRequestRef.current;
    const timeout = setTimeout(() => {
      setPreviewingFingerprint(fingerprint);
      setPreviewErrorFingerprint(null);
      void axios
        .post<RemovalPreview>(
          '/api/v1/settings/removal/preview',
          proposedValues
        )
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
  }, [previewFingerprint, previewRetry, updateValues]);

  if (!values && !error) return <LoadingSpinner />;
  if (!values) {
    return (
      <div className="text-red-400">
        {intl.formatMessage(messages.loadFailed)}
      </div>
    );
  }

  const previewPresentation = removalPreviewPresentation(
    previewState,
    values,
    previewingFingerprint,
    previewErrorFingerprint
  );
  const preview = previewPresentation.value;
  const previewing = previewPresentation.refreshing;
  const previewError = previewPresentation.failed;
  const previewIsActionable = Boolean(
    preview &&
    previewPresentation.current &&
    !previewing &&
    !previewError &&
    !remoteValues
  );
  const clearPreviewIsCurrent = Boolean(
    previewIsActionable && clearPreviewFingerprint === previewFingerprint
  );
  const dirty = Boolean(
    savedValues && !removalSettingsEqual(savedValues, values)
  );

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
        current?.fingerprint === previewFingerprint
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
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
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
        <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-[minmax(0,27.25rem)] xl:grid-cols-[repeat(2,minmax(0,27.25rem))]">
          <RemovalPolicyEditor
            title={intl.formatMessage(messages.movies)}
            policy={values.movie}
            preview={preview?.movie ?? null}
            previewing={previewing}
            previewError={previewError}
            onRetryPreview={() => {
              setPreviewErrorFingerprint(null);
              setPreviewRetry((current) => current + 1);
            }}
            onChange={(movie) => updateValues({ ...values, movie })}
          />
          <RemovalPolicyEditor
            title={intl.formatMessage(messages.series)}
            policy={values.series}
            preview={preview?.series ?? null}
            previewing={previewing}
            previewError={previewError}
            onRetryPreview={() => {
              setPreviewErrorFingerprint(null);
              setPreviewRetry((current) => current + 1);
            }}
            onChange={(series) => updateValues({ ...values, series })}
          />
        </div>
      </section>

      {result && (
        <p className="mt-4 text-right text-sm text-gray-200">{result}</p>
      )}
      <div className="actions">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Tooltip content={intl.formatMessage(messages.clearDescription)}>
            <Button
              buttonType="danger"
              className="min-w-[8rem]"
              aria-label={intl.formatMessage(messages.clearItems, {
                count: preview?.actionableScheduleCount ?? 0,
              })}
              disabled={
                clearing ||
                saving ||
                !previewIsActionable ||
                (preview?.actionableScheduleCount ?? 0) === 0
              }
              onClick={() => {
                if (!previewIsActionable) return;
                setClearPreviewFingerprint(previewFingerprint);
                setShowClearConfirmation(true);
              }}
            >
              {clearing
                ? intl.formatMessage(messages.clearing)
                : intl.formatMessage(messages.clearItems, {
                    count: preview?.actionableScheduleCount ?? 0,
                  })}
            </Button>
          </Tooltip>
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
