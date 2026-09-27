import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import {
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import type {
  FreshCandidateDiagnosticResponse,
  FreshCandidateDiagnosticRow,
  FreshCandidateDiagnosticSort,
  FreshCandidateDiagnosticStatus,
} from '@server/lib/fresh/types';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import Select from 'react-select';
import useSWR from 'swr';

const statusLabels: Record<FreshCandidateDiagnosticStatus, string> = {
  all: 'All',
  resolved: 'Resolved',
  no_match: 'No Match',
  ambiguous: 'Ambiguous',
  temporary_failure: 'Temporary Provider Failure',
  pending: 'Pending Resolution',
  resolving: 'Resolving',
  outside_eligibility_window: 'Outside Eligibility Window',
  eligibility_unknown: 'Eligibility Unknown',
  excluded_content_filter: 'Excluded by Content Filter',
  visibility_expired: 'Visibility Expired',
  active_fresh: 'Active Fresh',
  needs_attention: 'Needs Attention',
};

const sortLabels: Record<FreshCandidateDiagnosticSort, string> = {
  'title.asc': 'Title A–Z',
  'title.desc': 'Title Z–A',
  status: 'Status',
  'year.desc': 'Year newest',
  'year.asc': 'Year oldest',
  'first_seen.desc': 'First Seen newest',
  'first_seen.asc': 'First Seen oldest',
  'last_seen.desc': 'Last Seen newest',
  'last_seen.asc': 'Last Seen oldest',
};

const ManualResolution = ({
  candidate,
  onResolved,
}: {
  candidate: FreshCandidateDiagnosticRow;
  onResolved: () => Promise<unknown>;
}) => {
  const [tmdbId, setTmdbId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <input
        className="w-28"
        type="text"
        inputMode="numeric"
        aria-label={`TMDB ID for ${candidate.displayTitle}`}
        placeholder="TMDB ID"
        value={tmdbId}
        onChange={(event) => setTmdbId(event.target.value)}
      />
      <Button
        disabled={busy || !/^\d+$/.test(tmdbId) || Number(tmdbId) < 1}
        onClick={async () => {
          setBusy(true);
          setMessage('');
          try {
            const response = await axios.post<{
              title: string;
              mediaType: string;
              tmdbId: number;
            }>(
              `/api/v1/settings/fresh/candidates/${candidate.candidateId}/resolve`,
              { tmdbId: Number(tmdbId) }
            );
            setMessage(
              `Resolved as ${response.data.title} (${response.data.mediaType}:${response.data.tmdbId}).`
            );
            await onResolved();
          } catch {
            setMessage('The TMDB identity could not be validated.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Resolve
      </Button>
      {message && <span className="text-sm text-gray-300">{message}</span>}
    </div>
  );
};

const EligibilityDetails = ({
  candidate,
  id,
}: {
  candidate: FreshCandidateDiagnosticRow;
  id: string;
}) => {
  const sourceLabels = {
    digital: 'Digital',
    physical: 'Physical',
    canonical_fallback: 'Canonical fallback',
    tv_first_air_date: 'TV first-air date',
    unavailable: 'Unavailable',
  } as const;
  const observationLabels = {
    digital: 'Digital',
    physical: 'Physical',
    unknown: 'Unknown',
  } as const;
  const rows = [
    ['First observed', new Date(candidate.firstObservedAt).toLocaleString()],
    ['Last observed', new Date(candidate.lastObservedAt).toLocaleString()],
    candidate.eligibility && [
      'Observation type',
      observationLabels[candidate.eligibility.observationType],
    ],
    candidate.eligibility && [
      'Eligibility date',
      candidate.eligibility.eligibilityDate ?? 'Unavailable',
    ],
    candidate.eligibility && [
      'Eligibility date source',
      sourceLabels[candidate.eligibility.eligibilityDateSource],
    ],
    candidate.eligibility?.firstQualifyingObservation && [
      'First qualifying observation',
      new Date(
        candidate.eligibility.firstQualifyingObservation
      ).toLocaleString(),
    ],
    candidate.eligibility && [
      'Age at observation',
      candidate.eligibility.ageDays === undefined
        ? 'Unknown'
        : `${candidate.eligibility.ageDays.toFixed(1)} days`,
    ],
    candidate.eligibility && [
      'Eligibility limit',
      `${candidate.eligibility.eligibilityLimitDays} days`,
    ],
    candidate.firstSeenAt && [
      'First Fresh',
      new Date(candidate.firstSeenAt).toLocaleString(),
    ],
    candidate.visibleUntil && [
      'Visible until',
      new Date(candidate.visibleUntil).toLocaleString(),
    ],
    candidate.membershipReason && [
      'Membership',
      statusLabels[candidate.displayStatus],
    ],
  ].filter(Boolean) as [string, string][];
  return (
    <dl
      id={id}
      className="mt-3 grid gap-x-6 gap-y-1 border-t border-gray-700 pt-3 text-sm text-gray-300 sm:grid-cols-2"
    >
      {rows.map(([label, value]) => (
        <div className="flex justify-between gap-3" key={label}>
          <dt className="text-gray-400">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
};

const CandidateRow = ({
  candidate,
  onResolved,
}: {
  candidate: FreshCandidateDiagnosticRow;
  onResolved: () => Promise<unknown>;
}) => {
  const [expanded, setExpanded] = useState(false);
  const detailsId = `fresh-candidate-${candidate.candidateId}-details`;
  const mediaPath = candidate.tmdbId
    ? `/${candidate.mediaType}/${candidate.tmdbId}`
    : undefined;
  const tmdbPath = candidate.tmdbId
    ? `https://www.themoviedb.org/${candidate.mediaType}/${candidate.tmdbId}`
    : undefined;
  return (
    <div className="rounded-md bg-gray-800 p-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="shrink-0 text-gray-400 transition hover:text-white"
            aria-label={`${expanded ? 'Hide' : 'Show'} eligibility details for ${candidate.displayTitle}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRightIcon
              className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {mediaPath ? (
              <Link
                href={mediaPath}
                className="truncate font-semibold hover:underline"
              >
                {candidate.displayTitle}
              </Link>
            ) : (
              <span className="truncate font-semibold">
                {candidate.displayTitle}
              </span>
            )}
            {candidate.matchYear ? (
              <span className="text-gray-400">· {candidate.matchYear}</span>
            ) : null}
            <span className="text-gray-400">
              · {candidate.mediaType === 'movie' ? 'Movie' : 'Series'}
            </span>
            {tmdbPath && candidate.tmdbId && (
              <a
                href={tmdbPath}
                className="inline-flex items-center gap-1 text-gray-300 hover:text-white hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                · TMDB {candidate.tmdbId}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
          <span>{statusLabels[candidate.displayStatus]}</span>
          {candidate.actionable && (
            <ManualResolution candidate={candidate} onResolved={onResolved} />
          )}
        </div>
      </div>
      {expanded && <EligibilityDetails candidate={candidate} id={detailsId} />}
    </div>
  );
};

const CandidateDiagnostics = () => {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [mediaType, setMediaType] = useState<'all' | 'movie' | 'tv'>('all');
  const [status, setStatus] = useState<FreshCandidateDiagnosticStatus>('all');
  const [sort, setSort] =
    useState<FreshCandidateDiagnosticSort>('last_seen.desc');
  const params = new URLSearchParams({
    page: String(page),
    mediaType,
    status,
    sort,
  });
  if (search.trim()) params.set('search', search.trim());
  const { data, error, mutate } = useSWR<FreshCandidateDiagnosticResponse>(
    `/api/v1/settings/fresh/candidates?${params}`
  );
  const change = (callback: () => void) => {
    setPage(1);
    callback();
  };
  return (
    <div className="mt-12">
      <h3 className="heading">Candidate Diagnostics</h3>
      <p className="description">
        Durable current candidate and membership state. This is separate from
        the latest synchronization attempt and survives restarts.
      </p>
      {data && (
        <div className="mb-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Total candidates', data.summary.totalCandidates, 'all'],
            ['Active Fresh', data.summary.activeFresh, 'active_fresh'],
            ['No Match', data.summary.noMatch, 'no_match'],
            ['Ambiguous', data.summary.ambiguous, 'ambiguous'],
            [
              'Temporary Failure',
              data.summary.temporaryFailure,
              'temporary_failure',
            ],
            [
              'Outside Eligibility Window',
              data.summary.outsideEligibilityWindow,
              'outside_eligibility_window',
            ],
            [
              'Eligibility Unknown',
              data.summary.eligibilityUnknown,
              'eligibility_unknown',
            ],
            [
              'Excluded by Content Filter',
              data.summary.excludedContentFilter,
              'excluded_content_filter',
            ],
            [
              'Visibility Expired',
              data.summary.visibilityExpired,
              'visibility_expired',
            ],
            ['Needs Attention', data.summary.needsAttention, 'needs_attention'],
          ].map(([label, value, cardStatus]) => (
            <button
              type="button"
              className={`rounded-md bg-gray-800 p-3 text-left hover:bg-gray-700 ${
                status === cardStatus ? 'ring-2 ring-indigo-500' : ''
              }`}
              key={label}
              aria-pressed={status === cardStatus}
              onClick={() =>
                change(() =>
                  setStatus(cardStatus as FreshCandidateDiagnosticStatus)
                )
              }
            >
              <div className="text-sm text-gray-400">{label}</div>
              <div className="text-2xl font-semibold">{value}</div>
            </button>
          ))}
        </div>
      )}
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <div className="form-input-field">
          <input
            type="text"
            aria-label="Search title"
            placeholder="Search title"
            value={search}
            onChange={(event) => change(() => setSearch(event.target.value))}
          />
        </div>
        <Select
          className="react-select-container"
          classNamePrefix="react-select"
          value={{
            value: mediaType,
            label:
              mediaType === 'all'
                ? 'All media'
                : mediaType === 'movie'
                  ? 'Movies'
                  : 'Series',
          }}
          options={[
            { value: 'all', label: 'All media' },
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'Series' },
          ]}
          onChange={(option) =>
            change(() =>
              setMediaType((option?.value ?? 'all') as typeof mediaType)
            )
          }
        />
        <Select
          className="react-select-container"
          classNamePrefix="react-select"
          value={{ value: status, label: statusLabels[status] }}
          options={(
            Object.keys(statusLabels) as FreshCandidateDiagnosticStatus[]
          ).map((value) => ({ value, label: statusLabels[value] }))}
          onChange={(option) => change(() => setStatus(option?.value ?? 'all'))}
        />
        <Select
          className="react-select-container"
          classNamePrefix="react-select"
          value={{ value: sort, label: sortLabels[sort] }}
          options={(
            Object.keys(sortLabels) as FreshCandidateDiagnosticSort[]
          ).map((value) => ({ value, label: sortLabels[value] }))}
          onChange={(option) =>
            change(() => setSort(option?.value ?? 'last_seen.desc'))
          }
        />
      </div>
      {!data && !error && <LoadingSpinner />}
      {error && (
        <p className="text-red-400">
          Candidate diagnostics could not be loaded.
        </p>
      )}
      {data && (
        <>
          <div className="space-y-2">
            {data.results.map((candidate) => (
              <CandidateRow
                key={candidate.candidateId}
                candidate={candidate}
                onResolved={mutate}
              />
            ))}
            {data.results.length === 0 && (
              <p className="text-gray-400">
                No candidates match these filters.
              </p>
            )}
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            <Button
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </Button>
            <span>
              Page {data.pageInfo.page} of {Math.max(data.pageInfo.pages, 1)}
            </span>
            <Button
              disabled={page >= data.pageInfo.pages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default CandidateDiagnostics;
