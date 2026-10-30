import Button from '@app/components/Common/Button';
import SlideOver from '@app/components/Common/SlideOver';
import Tooltip from '@app/components/Common/Tooltip';
import { UserAvatar } from '@app/components/Library/LibraryEngagement';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import Datepicker from '@seerr-team/react-tailwindcss-datepicker';
import type {
  LibraryFilterUser,
  LibraryRemovalSource,
} from '@server/interfaces/api/libraryInterfaces';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import type { LibraryPreferences } from './preferences';
import {
  clearLibraryDrawerFilters,
  countActiveLibraryFilters,
  hasLibraryUserAssociationFilter,
  isLibraryScopeSelected,
  normalizeLibraryDate,
  toggleLibraryScopeSelection,
  toggleLibraryUserSelection,
} from './preferences';

const messages = defineMessages('components.Library.FilterSlideover', {
  filters: 'Filters',
  activeFilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  libraryScope: 'Media Status',
  scopeCurrent: 'Active',
  scopeArchive: 'Archived',
  storage: 'Storage locations',
  users: 'Users',
  watchlist: 'Watchlist',
  watched: 'Watched',
  requested: 'Requested',
  liked: 'Liked',
  added: 'Added Date',
  activity: 'Has Activity',
  lastActive: 'Last Active Date',
  scheduled: 'Leaving Soon',
  animation: 'Animation',
  collectionMembership: 'In Collection',
  removalDue: 'Scheduled Removal Date',
  archive: 'Archive',
  removed: 'Removed Date',
  removalSource: 'Removal source',
  from: 'From',
  to: 'To',
  any: 'Any',
  yes: 'Yes',
  no: 'No',
  manual: 'Manual',
  scheduledSource: 'Scheduled',
  external: 'External',
  unknown: 'Unknown',
  allStorage: 'All storage locations',
  clear: 'Clear filters',
});

type Option = { value: number; label: string };

const Section = ({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="space-y-4">
    <h3 className="text-lg font-semibold text-white">{title}</h3>
    {children}
  </section>
);

type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

const segmentedOptionClass = (
  selected: boolean,
  index: number,
  optionCount: number
): string =>
  `relative inline-flex min-w-[3.25rem] cursor-pointer items-center justify-center border px-3 py-1.5 text-sm font-medium transition peer-focus:z-20 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500 ${
    index === 0 ? 'rounded-l-md' : ''
  } ${index === optionCount - 1 ? 'rounded-r-md' : ''} ${
    selected
      ? 'z-10 border-indigo-500 bg-indigo-600/80 text-white'
      : 'border-gray-600 bg-gray-800/80 text-gray-300 hover:bg-gray-700 hover:text-white'
  }`;

function SegmentedFilter<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2">{label}</legend>
      <div className="isolate inline-flex rounded-md shadow-sm">
        {options.map((option, index) => {
          const selected = value === option.value;
          return (
            <label className={index > 0 ? '-ml-px' : ''} key={option.value}>
              <input
                type="radio"
                className="peer sr-only"
                name={`library-${name}-filter`}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
              />
              <span
                className={segmentedOptionClass(
                  selected,
                  index,
                  options.length
                )}
              >
                {option.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const MediaStatusFilter = ({
  label,
  activeLabel,
  archivedLabel,
  value,
  onChange,
}: {
  label: string;
  activeLabel: string;
  archivedLabel: string;
  value: LibraryPreferences['scope'];
  onChange: (value: LibraryPreferences['scope']) => void;
}) => {
  const options = [
    { value: 'active', label: activeLabel },
    { value: 'archived', label: archivedLabel },
  ] as const;
  return (
    <fieldset>
      <legend className="mb-2">{label}</legend>
      <div className="isolate inline-flex rounded-md shadow-sm">
        {options.map((option, index) => {
          const selected = isLibraryScopeSelected(value, option.value);
          return (
            <label className={index > 0 ? '-ml-px' : ''} key={option.value}>
              <input
                type="checkbox"
                className="peer sr-only"
                name={`library-scope-${option.value}`}
                checked={selected}
                onChange={() =>
                  onChange(toggleLibraryScopeSelection(value, option.value))
                }
              />
              <span
                className={segmentedOptionClass(
                  selected,
                  index,
                  options.length
                )}
              >
                {option.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
};

const DateRange = ({
  label,
  from,
  to,
  inputName,
  onChange,
}: {
  label: string;
  from?: string;
  to?: string;
  inputName: string;
  onChange: (value: { from?: string; to?: string }) => void;
}) => {
  const intl = useIntl();
  return (
    <div>
      <div className="mb-2 text-lg font-semibold">{label}</div>
      <div className="flex space-x-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-2">{intl.formatMessage(messages.from)}</div>
          <Datepicker
            key={`${inputName}-from-${from ?? 'empty'}`}
            primaryColor="indigo"
            value={{ startDate: from ?? null, endDate: from ?? null }}
            onChange={(value) =>
              onChange({
                from: normalizeLibraryDate(value?.startDate),
                to,
              })
            }
            inputName={`${inputName}-from`}
            useRange={false}
            asSingle
            containerClassName="datepicker-wrapper"
            inputClassName="pr-1 sm:pr-4 text-base leading-5"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-2">{intl.formatMessage(messages.to)}</div>
          <Datepicker
            key={`${inputName}-to-${to ?? 'empty'}`}
            primaryColor="indigo"
            value={{ startDate: to ?? null, endDate: to ?? null }}
            onChange={(value) =>
              onChange({
                from,
                to: normalizeLibraryDate(value?.startDate),
              })
            }
            inputName={`${inputName}-to`}
            useRange={false}
            asSingle
            containerClassName="datepicker-wrapper"
            inputClassName="pr-1 sm:pr-4 text-base leading-5"
          />
        </div>
      </div>
    </div>
  );
};

interface FilterSlideoverProps {
  show: boolean;
  onClose: () => void;
  preferences: LibraryPreferences;
  onChange: (preferences: LibraryPreferences) => void;
  users: LibraryFilterUser[];
  storageLocations: { id: number; label: string }[];
}

const FilterSlideover = ({
  show,
  onClose,
  preferences,
  onChange,
  users,
  storageLocations,
}: FilterSlideoverProps) => {
  const intl = useIntl();
  const userSelectionEnabled = hasLibraryUserAssociationFilter(preferences);
  const update = (change: Partial<LibraryPreferences>) =>
    onChange({ ...preferences, ...change });
  const storageOptions = storageLocations.map((location) => ({
    value: location.id,
    label: location.label,
  }));
  const triStateOptions = [
    { value: 'any', label: intl.formatMessage(messages.any) },
    { value: 'yes', label: intl.formatMessage(messages.yes) },
    { value: 'no', label: intl.formatMessage(messages.no) },
  ] as const;
  const activityOptions = [
    { value: 'any', label: intl.formatMessage(messages.any) },
    { value: 'present', label: intl.formatMessage(messages.yes) },
    { value: 'none', label: intl.formatMessage(messages.no) },
  ] as const;
  const collectionMembershipOptions = [
    { value: 'any', label: intl.formatMessage(messages.any) },
    { value: 'in', label: intl.formatMessage(messages.yes) },
    { value: 'none', label: intl.formatMessage(messages.no) },
  ] as const;
  const removalSourceOptions: {
    value: LibraryRemovalSource;
    label: string;
  }[] = [
    { value: 'manual', label: intl.formatMessage(messages.manual) },
    {
      value: 'scheduled',
      label: intl.formatMessage(messages.scheduledSource),
    },
    { value: 'external', label: intl.formatMessage(messages.external) },
    { value: 'unknown', label: intl.formatMessage(messages.unknown) },
  ];

  return (
    <SlideOver
      show={show}
      title={intl.formatMessage(messages.filters)}
      subText={intl.formatMessage(messages.activeFilters, {
        count: countActiveLibraryFilters(preferences),
      })}
      onClose={onClose}
    >
      <div className="flex flex-col space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MediaStatusFilter
            label={intl.formatMessage(messages.libraryScope)}
            activeLabel={intl.formatMessage(messages.scopeCurrent)}
            archivedLabel={intl.formatMessage(messages.scopeArchive)}
            value={preferences.scope}
            onChange={(scope) => update({ scope })}
          />
          <SegmentedFilter
            name="activity"
            label={intl.formatMessage(messages.activity)}
            value={preferences.activity}
            options={activityOptions}
            onChange={(activity) => update({ activity })}
          />
          {preferences.scope !== 'archive' && (
            <SegmentedFilter
              name="scheduled"
              label={intl.formatMessage(messages.scheduled)}
              value={preferences.scheduled}
              options={triStateOptions}
              onChange={(scheduled) => update({ scheduled })}
            />
          )}
          <SegmentedFilter
            name="animation"
            label={intl.formatMessage(messages.animation)}
            value={preferences.animation}
            options={triStateOptions}
            onChange={(animation) => update({ animation })}
          />
          <SegmentedFilter
            name="collection-membership"
            label={intl.formatMessage(messages.collectionMembership)}
            value={preferences.collectionMembership}
            options={collectionMembershipOptions}
            onChange={(collectionMembership) =>
              update({ collectionMembership })
            }
          />
        </div>

        <div className="border-t border-gray-700" aria-hidden="true" />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SegmentedFilter
            name="watchlist"
            label={intl.formatMessage(messages.watchlist)}
            value={preferences.watchlist}
            options={triStateOptions}
            onChange={(watchlist) => update({ watchlist })}
          />
          <SegmentedFilter
            name="watched"
            label={intl.formatMessage(messages.watched)}
            value={preferences.watched}
            options={triStateOptions}
            onChange={(watched) => update({ watched })}
          />
          <SegmentedFilter
            name="requested"
            label={intl.formatMessage(messages.requested)}
            value={preferences.requested}
            options={triStateOptions}
            onChange={(requested) => update({ requested })}
          />
          <SegmentedFilter
            name="liked"
            label={intl.formatMessage(messages.liked)}
            value={preferences.liked}
            options={triStateOptions}
            onChange={(liked) => update({ liked })}
          />
        </div>

        <Section title={intl.formatMessage(messages.users)}>
          <div className="flex flex-wrap gap-2">
            {users.map((user) => {
              const selected =
                userSelectionEnabled && preferences.userIds.includes(user.id);
              return (
                <Tooltip content={user.displayName} key={user.id}>
                  <button
                    type="button"
                    aria-label={user.displayName}
                    aria-pressed={selected}
                    disabled={!userSelectionEnabled}
                    className={`inline-flex rounded-full p-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
                      selected
                        ? 'bg-indigo-600 ring-2 ring-indigo-400'
                        : 'hover:bg-gray-700'
                    } ${
                      !userSelectionEnabled
                        ? 'cursor-not-allowed opacity-40 grayscale'
                        : user.available
                          ? ''
                          : 'opacity-40 grayscale hover:opacity-70'
                    }`}
                    onClick={() =>
                      update({
                        userIds: toggleLibraryUserSelection(
                          preferences.userIds,
                          user.id
                        ),
                      })
                    }
                  >
                    <UserAvatar user={user} showTooltip={false} />
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </Section>

        <div className="relative z-40 space-y-4">
          <DateRange
            label={intl.formatMessage(messages.added)}
            from={preferences.addedFrom}
            to={preferences.addedTo}
            inputName="library-added"
            onChange={({ from, to }) =>
              update({ addedFrom: from, addedTo: to })
            }
          />
          <DateRange
            label={intl.formatMessage(messages.lastActive)}
            from={preferences.activityFrom}
            to={preferences.activityTo}
            inputName="library-last-active"
            onChange={({ from, to }) =>
              update({ activityFrom: from, activityTo: to })
            }
          />
          {preferences.scope !== 'archive' && (
            <DateRange
              label={intl.formatMessage(messages.removalDue)}
              from={preferences.removalDueFrom}
              to={preferences.removalDueTo}
              inputName="library-removal-due"
              onChange={({ from, to }) =>
                update({ removalDueFrom: from, removalDueTo: to })
              }
            />
          )}
          {preferences.scope !== 'current' && (
            <DateRange
              label={intl.formatMessage(messages.removed)}
              from={preferences.removedFrom}
              to={preferences.removedTo}
              inputName="library-removed"
              onChange={({ from, to }) =>
                update({ removedFrom: from, removedTo: to })
              }
            />
          )}
        </div>

        <Section title={intl.formatMessage(messages.storage)}>
          <Select<Option, true>
            aria-label={intl.formatMessage(messages.storage)}
            className="react-select-container"
            classNamePrefix="react-select"
            isMulti
            options={storageOptions}
            placeholder={intl.formatMessage(messages.allStorage)}
            value={storageOptions.filter((option) =>
              preferences.storageRootIds.includes(option.value)
            )}
            onChange={(selected) =>
              update({ storageRootIds: selected.map((option) => option.value) })
            }
          />
        </Section>

        {preferences.scope !== 'current' && (
          <Section title={intl.formatMessage(messages.archive)}>
            <div className="space-y-2">
              <label className="mb-2 block" htmlFor="library-removal-source">
                {intl.formatMessage(messages.removalSource)}
              </label>
              <Select<{ value: LibraryRemovalSource; label: string }, true>
                inputId="library-removal-source"
                className="react-select-container"
                classNamePrefix="react-select"
                isMulti
                options={removalSourceOptions}
                value={removalSourceOptions.filter((option) =>
                  preferences.removalSources.includes(option.value)
                )}
                onChange={(selected) =>
                  update({
                    removalSources: selected.map((option) => option.value),
                  })
                }
              />
            </div>
          </Section>
        )}

        <div className="pt-4">
          <Button
            className="w-full"
            disabled={countActiveLibraryFilters(preferences) === 0}
            onClick={() => onChange(clearLibraryDrawerFilters(preferences))}
          >
            <XCircleIcon />
            <span>{intl.formatMessage(messages.clear)}</span>
          </Button>
        </div>
      </div>
    </SlideOver>
  );
};

export default FilterSlideover;
