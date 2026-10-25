import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import type { FreshStatus } from '@app/components/Fresh/api';
import FreshContentFilters from '@app/components/Settings/SettingsFresh/FreshContentFilters';
import {
  toFreshSettingsDraft,
  toFreshSettingsUpdate,
  type FreshSettingsDraft,
  type FreshSettingsResponse,
} from '@app/components/Settings/SettingsFresh/settingsFresh';
import defineMessages from '@app/utils/defineMessages';
import type { AutobrrFilterOption } from '@server/api/autobrr';
import type { FreshSettings } from '@server/lib/settings';
import axios from 'axios';
import { ErrorMessage, Field, Form, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsFresh', {
  title: 'Fresh',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  ssl: 'Use SSL',
  testAndLoad: 'Test Connection & Load Filters',
  invalid: 'Enter a valid value.',
  description:
    'Automatically discover Movies and Series from an approved autobrr filter.',
  enabled: 'Enable Fresh',
  apiToken: 'API Token',
  tokenSaved: 'Token configured; leave blank to keep it',
  filter: 'autobrr Filter',
  selectFilter: 'Select a filter',
  visibility: 'Fresh Visibility (Days)',
  visibilityTip:
    'Discovery dates come from autobrr. Older discoveries remain historical.',
  save: 'Save Changes',
  saved: 'Fresh settings saved.',
  tested: 'Connection successful.',
  failed:
    'Unable to complete the action. Check your configuration and try again.',
  loadFailed: 'Unable to load Fresh settings.',
  health: 'Synchronization',
  disabled: 'Disabled',
  preparing: 'Processing release history',
  refreshing: 'Synchronizing',
  ready: 'Up to date',
  stale: 'Retrying synchronization',
  unavailable: 'Temporarily unavailable',
});

export { toFreshSettingsDraft } from './settingsFresh';
export type {
  FreshSettingsDraft,
  FreshSettingsResponse,
} from './settingsFresh';

export const createFreshSettingsValidation = (invalid: string) =>
  Yup.object({
    port: Yup.number().integer().min(1).max(65535).required(invalid),
    hostname: Yup.string()
      .matches(/^[^\s/@?#]*$/, invalid)
      .test('connection-host', invalid, function (hostname) {
        try {
          toFreshSettingsUpdate({
            ...(this.parent as FreshSettingsDraft),
            port: Number(this.parent.port),
            hostname: hostname ?? '',
          });
          return true;
        } catch {
          return false;
        }
      })
      .when('enabled', {
        is: true,
        then: (schema) => schema.required(invalid),
      }),
    freshVisibilityDays: Yup.number()
      .integer()
      .min(1)
      .max(90)
      .required(invalid),
    minimumTmdbScore: Yup.number().min(0).max(10).required(invalid),
    minimumTmdbVotes: Yup.number()
      .integer()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .required(invalid),
  });

export const FreshSettingsForm = ({
  data,
  filters,
  health,
  onSave,
  onTest,
  onFilters,
}: {
  data: FreshSettingsResponse;
  filters: AutobrrFilterOption[];
  health?: FreshStatus;
  onSave: (values: FreshSettings) => Promise<void>;
  onTest: (values: FreshSettings) => Promise<void>;
  onFilters: (values: FreshSettings) => Promise<void>;
}) => {
  const intl = useIntl();
  const [testing, setTesting] = useState(false);
  const validationSchema = createFreshSettingsValidation(
    intl.formatMessage(messages.invalid)
  );
  // Text-style numeric fields retain draft strings while editing. Formik validates
  // but does not cast submitted values; retain the existing numeric API contract.
  const updateFromDraft = (values: FreshSettingsDraft) =>
    toFreshSettingsUpdate(validationSchema.cast(values) as FreshSettingsDraft);
  return (
    <Formik
      initialValues={toFreshSettingsDraft(data)}
      validationSchema={validationSchema}
      onSubmit={(values) => onSave(updateFromDraft(values))}
    >
      {({ values, isSubmitting, setFieldValue, validateForm }) => (
        <Form>
          <div className="flex items-center justify-between gap-4">
            <h3 className="heading min-w-0">
              {intl.formatMessage(messages.title)}
            </h3>
            <SlideCheckbox
              checked={values.enabled}
              ariaLabel={intl.formatMessage(messages.enabled)}
              disabled={isSubmitting || testing}
              onClick={() => {
                void setFieldValue('enabled', !values.enabled);
              }}
            />
          </div>
          <p className="description">
            {intl.formatMessage(messages.description)}
          </p>
          <div className="section">
            <div className="form-row">
              <label htmlFor="fresh-hostname" className="text-label">
                {intl.formatMessage(messages.hostname)}
                <span className="label-required" aria-hidden="true">
                  *
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <span className="protocol">
                    {values.ssl ? 'https://' : 'http://'}
                  </span>
                  <Field
                    id="fresh-hostname"
                    name="hostname"
                    type="text"
                    inputMode="url"
                    className="rounded-r-only"
                  />
                </div>
                <ErrorMessage
                  name="hostname"
                  component="div"
                  className="error"
                />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="fresh-port" className="text-label">
                {intl.formatMessage(messages.port)}
                <span className="label-required" aria-hidden="true">
                  *
                </span>
              </label>
              <div className="form-input-area">
                <Field
                  id="fresh-port"
                  name="port"
                  type="text"
                  inputMode="numeric"
                  className="short rounded-md border border-gray-500 bg-gray-700 text-white transition duration-150 ease-in-out sm:text-sm sm:leading-5"
                  required
                />
                <ErrorMessage name="port" component="div" className="error" />
              </div>
            </div>
            <div className="form-row">
              <span id="fresh-ssl-label" className="group-label sm:mt-1">
                {intl.formatMessage(messages.ssl)}
              </span>
              <div className="form-input-area">
                <SlideCheckbox
                  checked={values.ssl}
                  ariaLabel={intl.formatMessage(messages.ssl)}
                  disabled={isSubmitting}
                  onClick={() => {
                    void setFieldValue('ssl', !values.ssl);
                  }}
                />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="fresh-api-token" className="text-label">
                {intl.formatMessage(messages.apiToken)}
                <span className="label-required" aria-hidden="true">
                  *
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <SensitiveInput
                    as="field"
                    id="fresh-api-token"
                    name="apiToken"
                    placeholder={
                      data.apiTokenConfigured
                        ? intl.formatMessage(messages.tokenSaved)
                        : ''
                    }
                  />
                </div>
              </div>
            </div>
            <div className="form-row">
              <span className="text-label" />
              <div className="form-input-area">
                <Button
                  type="button"
                  disabled={isSubmitting || testing}
                  onClick={async () => {
                    if (Object.keys(await validateForm()).length) return;
                    setTesting(true);
                    try {
                      const update = updateFromDraft(values);
                      await onTest(update);
                      await onFilters(update);
                    } catch {
                      // The parent action reports connection failures.
                    } finally {
                      setTesting(false);
                    }
                  }}
                >
                  {intl.formatMessage(messages.testAndLoad)}
                </Button>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="fresh-filter" className="text-label">
                {intl.formatMessage(messages.filter)}
                <span className="label-required" aria-hidden="true">
                  *
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    as="select"
                    id="fresh-filter"
                    name="filterId"
                    value={values.filterId}
                    onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                      const filterId = Number(event.target.value);
                      void setFieldValue('filterId', filterId);
                      void setFieldValue(
                        'cachedFilterName',
                        filters.find((filter) => filter.id === filterId)
                          ?.name ?? ''
                      );
                    }}
                  >
                    <option value={0}>
                      {intl.formatMessage(messages.selectFilter)}
                    </option>
                    {values.filterId > 0 &&
                      !filters.some(
                        (filter) => filter.id === values.filterId
                      ) && (
                        <option value={values.filterId}>
                          {values.cachedFilterName || values.filterId}
                        </option>
                      )}
                    {filters.map((filter) => (
                      <option
                        key={filter.id}
                        value={filter.id}
                        disabled={filter.enabled === false}
                      >
                        {filter.name}
                      </option>
                    ))}
                  </Field>
                </div>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="fresh-visibility" className="text-label">
                {intl.formatMessage(messages.visibility)}
              </label>
              <div className="form-input-area">
                <Field
                  id="fresh-visibility"
                  name="freshVisibilityDays"
                  type="text"
                  inputMode="numeric"
                  className="short rounded-md border border-gray-500 bg-gray-700 text-white transition duration-150 ease-in-out sm:text-sm sm:leading-5"
                  required
                />
                <ErrorMessage
                  name="freshVisibilityDays"
                  component="div"
                  className="error"
                />
                <p className="label-tip">
                  {intl.formatMessage(messages.visibilityTip)}
                </p>
              </div>
            </div>
          </div>
          <FreshContentFilters />
          <div className="actions flex flex-wrap gap-2">
            <Button
              buttonType="primary"
              type="submit"
              disabled={isSubmitting || testing}
            >
              {intl.formatMessage(messages.save)}
            </Button>
          </div>
          <p className="mt-4 text-sm text-gray-400" role="status">
            {intl.formatMessage(messages.health)}:{' '}
            {intl.formatMessage(messages[health?.status ?? 'unavailable'])}
          </p>
        </Form>
      )}
    </Formik>
  );
};

const SettingsFresh = () => {
  const intl = useIntl();
  const { data, error, mutate } = useSWR<FreshSettingsResponse>(
    '/api/v1/settings/fresh'
  );
  const { data: health, mutate: revalidateHealth } = useSWR<FreshStatus>(
    '/api/v1/settings/fresh/status'
  );
  const [filters, setFilters] = useState<AutobrrFilterOption[]>([]);
  const [notice, setNotice] = useState<'saved' | 'tested' | 'failed'>();
  const connection = (values: FreshSettings) => ({
    baseUrl: values.baseUrl,
    apiToken: values.apiToken,
  });
  if (error)
    return (
      <p role="alert" className="text-red-400">
        {intl.formatMessage(messages.loadFailed)}
      </p>
    );
  if (!data) return <LoadingSpinner />;
  return (
    <>
      <FreshSettingsForm
        data={data}
        health={health}
        filters={filters}
        onSave={async (values) => {
          try {
            await axios.put('/api/v1/settings/fresh', values);
            setNotice('saved');
            await mutate();
            await revalidateHealth();
          } catch {
            setNotice('failed');
          }
        }}
        onTest={async (values) => {
          try {
            await axios.post('/api/v1/settings/fresh/test', connection(values));
            setNotice('tested');
          } catch (error) {
            setNotice('failed');
            throw error;
          }
        }}
        onFilters={async (values) => {
          try {
            const response = await axios.post<AutobrrFilterOption[]>(
              '/api/v1/settings/fresh/filters',
              connection(values)
            );
            setFilters(response.data);
          } catch (error) {
            setNotice('failed');
            throw error;
          }
        }}
      />
      {notice && (
        <p
          className={notice === 'failed' ? 'text-red-400' : 'text-gray-300'}
          role={notice === 'failed' ? 'alert' : 'status'}
        >
          {intl.formatMessage(messages[notice])}
        </p>
      )}
    </>
  );
};
export default SettingsFresh;
