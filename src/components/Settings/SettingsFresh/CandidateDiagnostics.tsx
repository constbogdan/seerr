import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import MediaTypeFilter from '@app/components/Common/MediaTypeFilter';
import {
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import type {
  FreshCandidateDiagnosticResponse,
  FreshCandidateDiagnosticRow,
  FreshCandidateDiagnosticSort,
  FreshCandidateDiagnosticStatus,
  FreshCandidatePresenceFilter,
  FreshCandidateReasonFamily,
  FreshCandidateSeasonEvidence,
  FreshCandidateVisibilityFilter,
} from '@server/lib/fresh/types';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import Select from 'react-select';
import useSWR from 'swr';
import {
  applyCandidateVisibilityLocally,
  bulkCandidateVisibilityTargets,
  candidatePageSelectionState,
  candidateSelectionScopeKey,
  nearestCandidatePage,
  toggleCandidatePageSelection,
  toggleCandidateSelection,
} from './candidateSelection';

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
  reviewable: 'Reviewable',
  historical: 'Historical',
};

const sortLabels: Record<FreshCandidateDiagnosticSort, string> = {
  priority: 'Needs Attention first',
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

const reasonFamilyLabels: Record<FreshCandidateReasonFamily, string> = {
  all: 'All reason families',
  resolution: 'Resolution',
  admission: 'Admission policy',
  content: 'Content policy',
  history: 'Discovery history',
  source: 'Source continuity',
};

const seasonEvidenceLabels: Record<FreshCandidateSeasonEvidence, string> = {
  all: 'All season evidence',
  known: 'Season known',
  unknown: 'Season unknown',
};

const presenceLabels: Record<FreshCandidatePresenceFilter, string> = {
  all: 'Any',
  present: 'Present',
  absent: 'Absent',
};

const visibilityLabels: Record<FreshCandidateVisibilityFilter, string> = {
  visible: 'Visible',
  hidden: 'Hidden',
  all: 'All',
};

const diagnosticReasonLabel = (value: string) =>
  value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const ManualResolution = ({
  candidate,
  onResolved,
}: {
  candidate: FreshCandidateDiagnosticRow;
  onResolved: () => Promise<unknown>;
}) => {
  const [tmdbId, setTmdbId] = useState('');
  const [mediaType, setMediaType] = useState<'movie' | 'tv'>(
    candidate.mediaType
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <select
        aria-label={`TMDB media type for ${candidate.displayTitle}`}
        value={mediaType}
        onChange={(event) => setMediaType(event.target.value as 'movie' | 'tv')}
      >
        <option value="movie">Movie</option>
        <option value="tv">TV</option>
      </select>
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
              {
                mediaType,
                tmdbId: Number(tmdbId),
                expectedRevision: candidate.revision,
              }
            );
            setMessage(
              `Resolved as ${response.data.title} (${response.data.mediaType}:${response.data.tmdbId}).`
            );
            await onResolved();
          } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 409) {
              setMessage('Candidate changed. Reloaded the current state.');
              await onResolved();
            } else {
              setMessage('The TMDB identity could not be validated.');
            }
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

const CandidateMutation = ({
  candidate,
  endpoint,
  label,
  buttonType,
  onChanged,
  onConflict,
}: {
  candidate: FreshCandidateDiagnosticRow;
  endpoint:
    | 'reset-resolution'
    | 'admit'
    | 'remove-override'
    | 'dismiss'
    | 'show';
  label: string;
  buttonType?: 'default' | 'primary' | 'danger' | 'warning' | 'success';
  onChanged: () => Promise<unknown>;
  onConflict?: () => Promise<unknown>;
}) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <>
      <Button
        buttonType={buttonType}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage('');
          try {
            await axios.post(
              `/api/v1/settings/fresh/candidates/${candidate.candidateId}/${endpoint}`,
              { expectedRevision: candidate.revision }
            );
            await onChanged();
          } catch (error) {
            setMessage(
              axios.isAxiosError(error) && error.response?.status === 409
                ? 'Candidate changed. Reloaded the current state.'
                : 'The candidate could not be updated.'
            );
            if (axios.isAxiosError(error) && error.response?.status === 409) {
              await (onConflict ?? onChanged)();
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </Button>
      {message && <span className="text-sm text-gray-300">{message}</span>}
    </>
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
    ['Parsed title', candidate.parsedTitle],
    ['Parsed type', candidate.parsedMediaType === 'movie' ? 'Movie' : 'TV'],
    candidate.seasonNumber !== undefined && [
      'Parsed season',
      `S${String(candidate.seasonNumber).padStart(2, '0')}`,
    ],
    candidate.episodeNumber !== undefined && [
      'Parsed episode',
      `E${String(candidate.episodeNumber).padStart(2, '0')}`,
    ],
    candidate.automaticResolution && [
      'Automatic resolution',
      candidate.automaticResolution.tmdbId
        ? `${candidate.automaticResolution.mediaType}:${candidate.automaticResolution.tmdbId}`
        : (candidate.automaticResolution.failureReason ?? 'Unresolved'),
    ],
    candidate.manualResolution && [
      'Manual resolution',
      `${candidate.manualResolution.mediaType}:${candidate.manualResolution.tmdbId} · ${candidate.manualResolution.canonicalTitle}`,
    ],
    ['Observations', String(candidate.observationCount)],
    candidate.sourceTitleSamples.length > 0 && [
      'Source samples',
      candidate.sourceTitleSamples.join(' · '),
    ],
    candidate.discoveryHistory?.activityDate && [
      'Activity date',
      `${candidate.discoveryHistory.activityDate} (${candidate.discoveryHistory.activitySource})`,
    ],
    candidate.automaticReasons.length > 0 && [
      'Automatic reasons',
      candidate.automaticReasons.map(diagnosticReasonLabel).join(', '),
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
  onVisibilityChanged,
  selected,
  onSelectionChange,
}: {
  candidate: FreshCandidateDiagnosticRow;
  onResolved: () => Promise<unknown>;
  onVisibilityChanged: (candidateId: number, show: boolean) => Promise<unknown>;
  selected: boolean;
  onSelectionChange: (selected: boolean) => void;
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
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-500 bg-gray-700 text-indigo-600 focus:ring-indigo-500"
            aria-label={`Select ${candidate.displayTitle}`}
            checked={selected}
            onChange={(event) => onSelectionChange(event.target.checked)}
          />
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
            {candidate.seasonNumber !== undefined ? (
              <span className="text-gray-400">
                · S{String(candidate.seasonNumber).padStart(2, '0')}
                {candidate.episodeNumber !== undefined
                  ? `E${String(candidate.episodeNumber).padStart(2, '0')}`
                  : ''}
              </span>
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
          {!candidate.active && candidate.automaticReasons[0] && (
            <span className="text-sm text-gray-400">
              {diagnosticReasonLabel(candidate.automaticReasons[0])}
            </span>
          )}
          {candidate.manualResolution && (
            <span className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium">
              Manual resolution
            </span>
          )}
          {candidate.admissionOverride && (
            <span className="rounded bg-amber-600 px-2 py-1 text-xs font-medium">
              Admission override
            </span>
          )}
          {candidate.actions.resolve && (
            <ManualResolution candidate={candidate} onResolved={onResolved} />
          )}
          {candidate.actions.resetResolution && (
            <CandidateMutation
              candidate={candidate}
              endpoint="reset-resolution"
              label="Reset resolution"
              onChanged={onResolved}
            />
          )}
          {candidate.actions.admit && (
            <CandidateMutation
              candidate={candidate}
              endpoint="admit"
              label="Admit to Fresh"
              buttonType="primary"
              onChanged={onResolved}
            />
          )}
          {candidate.actions.removeOverride && (
            <CandidateMutation
              candidate={candidate}
              endpoint="remove-override"
              label="Remove override"
              buttonType="danger"
              onChanged={onResolved}
            />
          )}
          {candidate.actions.dismiss && (
            <CandidateMutation
              candidate={candidate}
              endpoint="dismiss"
              label="Dismiss"
              onChanged={() =>
                onVisibilityChanged(candidate.candidateId, false)
              }
              onConflict={onResolved}
            />
          )}
          {candidate.actions.show && (
            <CandidateMutation
              candidate={candidate}
              endpoint="show"
              label="Show"
              onChanged={() => onVisibilityChanged(candidate.candidateId, true)}
              onConflict={onResolved}
            />
          )}
        </div>
      </div>
      {expanded && <EligibilityDetails candidate={candidate} id={detailsId} />}
    </div>
  );
};

const PageSelectionCheckbox = ({
  state,
  onChange,
  disabled,
}: {
  state: 'none' | 'some' | 'all';
  onChange: (selected: boolean) => void;
  disabled: boolean;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 rounded border-gray-500 bg-gray-700 text-indigo-600 focus:ring-indigo-500"
      aria-label="Select all candidates on this page"
      checked={state === 'all'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
};

const CandidateDiagnostics = ({
  showHeader = true,
}: {
  showHeader?: boolean;
}) => {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [mediaType, setMediaType] = useState<'all' | 'movie' | 'tv'>('all');
  const [status, setStatus] = useState<FreshCandidateDiagnosticStatus>('all');
  const [sort, setSort] = useState<FreshCandidateDiagnosticSort>('priority');
  const [reasonFamily, setReasonFamily] =
    useState<FreshCandidateReasonFamily>('all');
  const [seasonEvidence, setSeasonEvidence] =
    useState<FreshCandidateSeasonEvidence>('all');
  const [manualResolution, setManualResolution] =
    useState<FreshCandidatePresenceFilter>('all');
  const [admissionOverride, setAdmissionOverride] =
    useState<FreshCandidatePresenceFilter>('all');
  const [visibility, setVisibility] =
    useState<FreshCandidateVisibilityFilter>('visible');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState('');
  const selectionScope = candidateSelectionScopeKey({
    page,
    search,
    mediaType,
    status,
    sort,
    reasonFamily,
    seasonEvidence,
    manualResolution,
    admissionOverride,
    visibility,
  });
  useEffect(() => setSelectedIds([]), [selectionScope]);
  const params = new URLSearchParams({
    page: String(page),
    mediaType,
    status,
    sort,
    reasonFamily,
    seasonEvidence,
    manualResolution,
    admissionOverride,
    visibility,
  });
  if (search.trim()) params.set('search', search.trim());
  const { data, error, mutate } = useSWR<FreshCandidateDiagnosticResponse>(
    `/api/v1/settings/fresh/candidates?${params}`
  );
  const change = (callback: () => void) => {
    setSelectedIds([]);
    setPage(1);
    callback();
  };
  const pageSelection = candidatePageSelectionState(
    data?.results ?? [],
    selectedIds
  );
  const selectedOnPage = (data?.results ?? []).filter((candidate) =>
    selectedIds.includes(candidate.candidateId)
  ).length;
  const dismissTargets = bulkCandidateVisibilityTargets(
    data?.results ?? [],
    selectedIds,
    false
  );
  const showTargets = bulkCandidateVisibilityTargets(
    data?.results ?? [],
    selectedIds,
    true
  );
  const refreshAfterVisibilityChange = async (
    show: boolean,
    affectedIds: number[]
  ) => {
    setSelectedIds([]);
    await mutate(
      (current) =>
        applyCandidateVisibilityLocally(current, affectedIds, show, visibility),
      { revalidate: false }
    );
    const removesFromCurrentView =
      (visibility === 'visible' && !show) || (visibility === 'hidden' && show);
    if (data && removesFromCurrentView) {
      const nextPage = nearestCandidatePage(
        page,
        data.pageInfo.results,
        affectedIds.length,
        data.pageInfo.pageSize
      );
      if (nextPage !== page) {
        setPage(nextPage);
        return;
      }
    }
    void mutate();
  };
  const bulkVisibility = async (show: boolean) => {
    const candidates = show ? showTargets : dismissTargets;
    if (candidates.length === 0) return;
    setBulkBusy(true);
    setBulkMessage('');
    try {
      await axios.post('/api/v1/settings/fresh/candidates/visibility', {
        show,
        candidates,
      });
      await refreshAfterVisibilityChange(
        show,
        candidates.map(({ candidateId }) => candidateId)
      );
    } catch (error) {
      setSelectedIds([]);
      setBulkMessage(
        axios.isAxiosError(error) && error.response?.status === 409
          ? 'At least one candidate changed. Nothing was updated.'
          : 'The selected candidates could not be updated.'
      );
      await mutate();
    } finally {
      setBulkBusy(false);
    }
  };
  return (
    <div className={showHeader ? 'mt-12' : ''}>
      {showHeader && (
        <>
          <h3 className="heading">Candidate Diagnostics</h3>
          <p className="description">
            Durable current candidate and membership state. This is separate
            from the latest synchronization attempt and survives restarts.
          </p>
        </>
      )}
      {data && (
        <div className="mb-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Needs Attention', data.summary.needsAttention, 'needs_attention'],
            ['Reviewable', data.summary.reviewable, 'reviewable'],
            ['Active Fresh', data.summary.activeFresh, 'active_fresh'],
            ['Historical', data.summary.historical, 'historical'],
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
        <MediaTypeFilter
          id="freshCandidateMediaType"
          value={mediaType}
          options={[
            { value: 'all', label: 'All' },
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'Series' },
          ]}
          onChange={(value) =>
            change(() => setMediaType(value as typeof mediaType))
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
            change(() => setSort(option?.value ?? 'priority'))
          }
        />
      </div>
      <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Select
          aria-label="Candidate visibility"
          className="react-select-container"
          classNamePrefix="react-select"
          value={{ value: visibility, label: visibilityLabels[visibility] }}
          options={(
            Object.keys(visibilityLabels) as FreshCandidateVisibilityFilter[]
          ).map((value) => ({ value, label: visibilityLabels[value] }))}
          onChange={(option) =>
            change(() => setVisibility(option?.value ?? 'visible'))
          }
        />
        <Select
          aria-label="Reason family"
          className="react-select-container"
          classNamePrefix="react-select"
          value={{
            value: reasonFamily,
            label: reasonFamilyLabels[reasonFamily],
          }}
          options={(
            Object.keys(reasonFamilyLabels) as FreshCandidateReasonFamily[]
          ).map((value) => ({ value, label: reasonFamilyLabels[value] }))}
          onChange={(option) =>
            change(() => setReasonFamily(option?.value ?? 'all'))
          }
        />
        <Select
          aria-label="Season evidence"
          className="react-select-container"
          classNamePrefix="react-select"
          value={{
            value: seasonEvidence,
            label: seasonEvidenceLabels[seasonEvidence],
          }}
          options={(
            Object.keys(seasonEvidenceLabels) as FreshCandidateSeasonEvidence[]
          ).map((value) => ({ value, label: seasonEvidenceLabels[value] }))}
          onChange={(option) =>
            change(() => setSeasonEvidence(option?.value ?? 'all'))
          }
        />
        <Select
          aria-label="Manual resolution"
          className="react-select-container"
          classNamePrefix="react-select"
          value={{
            value: manualResolution,
            label: `Manual resolution: ${presenceLabels[manualResolution]}`,
          }}
          options={(
            Object.keys(presenceLabels) as FreshCandidatePresenceFilter[]
          ).map((value) => ({
            value,
            label: `Manual resolution: ${presenceLabels[value]}`,
          }))}
          onChange={(option) =>
            change(() => setManualResolution(option?.value ?? 'all'))
          }
        />
        <Select
          aria-label="Admission override"
          className="react-select-container"
          classNamePrefix="react-select"
          value={{
            value: admissionOverride,
            label: `Admission override: ${presenceLabels[admissionOverride]}`,
          }}
          options={(
            Object.keys(presenceLabels) as FreshCandidatePresenceFilter[]
          ).map((value) => ({
            value,
            label: `Admission override: ${presenceLabels[value]}`,
          }))}
          onChange={(option) =>
            change(() => setAdmissionOverride(option?.value ?? 'all'))
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
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-gray-800 px-3 py-2">
            <PageSelectionCheckbox
              state={pageSelection}
              disabled={data.results.length === 0 || bulkBusy}
              onChange={(selected) =>
                setSelectedIds(
                  toggleCandidatePageSelection(data.results, selected)
                )
              }
            />
            <span className="text-sm text-gray-300">
              {selectedOnPage > 0
                ? `${selectedOnPage} selected on this page`
                : 'Select this page'}
            </span>
            <div className="flex flex-wrap gap-2">
              {(visibility === 'visible' || visibility === 'all') &&
                dismissTargets.length > 0 && (
                  <Button
                    buttonType="danger"
                    disabled={bulkBusy}
                    onClick={() => bulkVisibility(false)}
                  >
                    Dismiss selected
                  </Button>
                )}
              {(visibility === 'hidden' || visibility === 'all') &&
                showTargets.length > 0 && (
                  <Button
                    disabled={bulkBusy}
                    onClick={() => bulkVisibility(true)}
                  >
                    Show selected
                  </Button>
                )}
            </div>
            {bulkMessage && (
              <span className="text-sm text-gray-300">{bulkMessage}</span>
            )}
          </div>
          <div className="space-y-2">
            {data.results.map((candidate) => (
              <CandidateRow
                key={candidate.candidateId}
                candidate={candidate}
                onResolved={mutate}
                onVisibilityChanged={(candidateId, show) =>
                  refreshAfterVisibilityChange(show, [candidateId])
                }
                selected={selectedIds.includes(candidate.candidateId)}
                onSelectionChange={(selected) =>
                  setSelectedIds((current) =>
                    toggleCandidateSelection(
                      current,
                      candidate.candidateId,
                      selected
                    )
                  )
                }
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
              onClick={() => {
                setSelectedIds([]);
                setPage((value) => value - 1);
              }}
            >
              Previous
            </Button>
            <span>
              Page {data.pageInfo.page} of {Math.max(data.pageInfo.pages, 1)}
            </span>
            <Button
              disabled={page >= data.pageInfo.pages}
              onClick={() => {
                setSelectedIds([]);
                setPage((value) => value + 1);
              }}
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
