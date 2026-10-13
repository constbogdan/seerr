import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Tooltip from '@app/components/Common/Tooltip';
import {
  CalendarDaysIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/solid';
import type { AutomaticRemovalPolicy } from '@server/constants/removal';
import { useState } from 'react';
import { useIntl } from 'react-intl';

import defineMessages from '@app/utils/defineMessages';
import { factualDaysAgo, parseFactualDate } from '@app/utils/factualDate';

const messages = defineMessages('components.Settings.SettingsRemoval', {
  olderThan: 'Older than',
  noActivityIn: 'No activity in',
  monthUnit: '{count, plural, one {month} other {months}}',
  itemsPerRun: 'Items per run',
  eligibleCount: '{count} eligible',
  candidateOrder: 'Sorted by Last active, oldest first.',
  showCandidates: 'Show next-batch candidates',
  hideCandidates: 'Hide next-batch candidates',
  noCandidates: 'No next-batch candidates.',
  addedFact: 'Added {date} ({days} days ago)',
  lastActiveFact: 'Last active {date} ({days} days ago)',
});

const ITEMS_PER_RUN_OPTIONS = Array.from(
  { length: 50 },
  (_, index) => index + 1
);

export interface RemovalPreviewCandidate {
  canonicalMediaId: number;
  title: string;
  year: number | null;
  addedAt: string;
  lastActiveAt: string | null;
}

export interface RemovalPreviewPool {
  eligibleUnscheduled: number;
  itemsPerRun: number;
  oldestCurrentAddedAt: string | null;
  maximumSelectableMonths: number;
  candidates: RemovalPreviewCandidate[];
}

interface RemovalPolicyEditorProps {
  title: string;
  policy: AutomaticRemovalPolicy;
  preview: RemovalPreviewPool | null;
  previewing: boolean;
  onChange: (policy: AutomaticRemovalPolicy) => void;
}

const RemovalPolicyEditor = ({
  title,
  policy,
  preview,
  previewing,
  onChange,
}: RemovalPolicyEditorProps) => {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const maximum =
    preview?.maximumSelectableMonths ??
    Math.max(0, policy.minimumAgeMonths, policy.inactivityMonths);
  const monthOptions = Array.from({ length: maximum + 1 }, (_, value) => value);
  const itemsPerRunOptions = ITEMS_PER_RUN_OPTIONS.includes(policy.itemsPerRun)
    ? ITEMS_PER_RUN_OPTIONS
    : [...ITEMS_PER_RUN_OPTIONS, policy.itemsPerRun].sort(
        (left, right) => left - right
      );
  const eligible = preview?.eligibleUnscheduled ?? 0;
  const set = <K extends keyof AutomaticRemovalPolicy>(
    key: K,
    value: AutomaticRemovalPolicy[K]
  ) => onChange({ ...policy, [key]: value });

  return (
    <div className="rounded-lg bg-gray-800 p-5 text-white shadow ring-1 ring-gray-700">
      <div className="flex items-center gap-3">
        <SlideCheckbox
          checked={policy.enabled}
          ariaLabel={title}
          onClick={() => set('enabled', !policy.enabled)}
        />
        <span className="text-xl font-bold text-white">{title}</span>
      </div>

      <div className="form-row">
        <label htmlFor={`${title}-minimum-age`} className="text-label">
          {intl.formatMessage(messages.olderThan)}
        </label>
        <div className="form-input-area">
          <select
            id={`${title}-minimum-age`}
            className="short"
            value={policy.minimumAgeMonths}
            onChange={(event) =>
              set('minimumAgeMonths', Number(event.target.value))
            }
          >
            {monthOptions.map((value) => (
              <option key={`age-${value}`} value={value}>
                {value}{' '}
                {intl.formatMessage(messages.monthUnit, { count: value })}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-row">
        <label htmlFor={`${title}-inactivity`} className="text-label">
          {intl.formatMessage(messages.noActivityIn)}
        </label>
        <div className="form-input-area">
          <select
            id={`${title}-inactivity`}
            className="short"
            value={policy.inactivityMonths}
            onChange={(event) =>
              set('inactivityMonths', Number(event.target.value))
            }
          >
            {monthOptions.map((value) => (
              <option key={`inactive-${value}`} value={value}>
                {value}{' '}
                {intl.formatMessage(messages.monthUnit, { count: value })}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 border-t border-gray-700 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm text-white">
            {previewing && !preview
              ? '...'
              : intl.formatMessage(messages.eligibleCount, {
                  count: eligible,
                })}
          </strong>
          <span className="text-gray-500" aria-hidden="true">
            &middot;
          </span>
          <select
            id={`${title}-items-per-run`}
            className="short flex-none"
            aria-label={intl.formatMessage(messages.itemsPerRun)}
            value={policy.itemsPerRun}
            onChange={(event) => set('itemsPerRun', Number(event.target.value))}
          >
            {itemsPerRunOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <Tooltip content={intl.formatMessage(messages.candidateOrder)}>
            <span
              className="inline-flex text-gray-400"
              tabIndex={0}
              aria-label={intl.formatMessage(messages.candidateOrder)}
            >
              <InformationCircleIcon className="h-5 w-5" />
            </span>
          </Tooltip>
          <button
            type="button"
            className="rounded p-1 text-gray-300 hover:bg-gray-700 hover:text-white"
            aria-expanded={expanded}
            aria-label={intl.formatMessage(
              expanded ? messages.hideCandidates : messages.showCandidates
            )}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronUpIcon className="h-5 w-5" />
            ) : (
              <ChevronDownIcon className="h-5 w-5" />
            )}
          </button>
        </div>
        {expanded && (
          <div className="mt-3 max-h-96 overflow-y-auto rounded-md border border-gray-700 bg-gray-900">
            {!preview || preview.candidates.length === 0 ? (
              <p className="p-3 text-sm text-gray-400">
                {intl.formatMessage(messages.noCandidates)}
              </p>
            ) : (
              <ul className="divide-y divide-gray-700">
                {preview.candidates.map((candidate) => (
                  <li key={candidate.canonicalMediaId} className="p-3">
                    <div className="font-medium text-white">
                      {candidate.title}
                      {candidate.year ? ` (${candidate.year})` : ''}
                    </div>
                    <div className="mt-1 space-y-1 text-xs text-gray-400">
                      <div className="flex items-center gap-1.5">
                        <CalendarDaysIcon className="h-4 w-4 flex-shrink-0" />
                        <span>
                          {intl.formatMessage(messages.addedFact, {
                            date: intl.formatDate(
                              parseFactualDate(candidate.addedAt)
                            ),
                            days: factualDaysAgo(candidate.addedAt),
                          })}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <ClockIcon className="h-4 w-4 flex-shrink-0" />
                        <span>
                          {candidate.lastActiveAt
                            ? intl.formatMessage(messages.lastActiveFact, {
                                date: intl.formatDate(
                                  parseFactualDate(candidate.lastActiveAt)
                                ),
                                days: factualDaysAgo(candidate.lastActiveAt),
                              })
                            : '—'}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default RemovalPolicyEditor;
