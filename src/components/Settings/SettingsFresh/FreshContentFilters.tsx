import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import type { TmdbGenre } from '@server/api/themoviedb/interfaces';
import type { Language } from '@server/lib/settings';
import { useFormikContext } from 'formik';
import { useMemo } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';
import type { FreshSettingsFormValues } from './settingsFresh';

interface CertificationResponse {
  certifications: Record<string, { certification: string }[]>;
}

type OptionValue = number | string;
type Option = { label: string; value: OptionValue };

const messages = defineMessages('components.Settings.SettingsFresh.Filters', {
  title: 'Fresh Content Filters',
  help: 'Include matches any selected value. Exclude matches any selected value and takes precedence.',
  includeGenres: 'Include Genres',
  excludeGenres: 'Exclude Genres',
  includeLanguages: 'Include Original Languages',
  excludeLanguages: 'Exclude Original Languages',
  includeRatings: 'Include Content Ratings',
  excludeRatings: 'Exclude Content Ratings',
  minimumScore: 'Minimum TMDB Score',
  minimumVotes: 'Minimum TMDB Votes',
  movie: 'Movie',
  series: 'Series',
});

const MultiSelect = ({
  options,
  value,
  onChange,
}: {
  options: Option[];
  value: OptionValue[];
  onChange: (value: OptionValue[]) => void;
}) => (
  <Select<Option, true>
    className="react-select-container"
    classNamePrefix="react-select"
    isMulti
    options={options}
    value={options.filter((option) => value.includes(option.value))}
    onChange={(selected) => onChange(selected.map((option) => option.value))}
  />
);

const FreshContentFilters = () => {
  const intl = useIntl();
  const { values, setFieldValue, errors, touched } =
    useFormikContext<FreshSettingsFormValues>();
  const { currentSettings } = useSettings();
  const { data: movieGenres } = useSWR<TmdbGenre[]>('/api/v1/genres/movie');
  const { data: tvGenres } = useSWR<TmdbGenre[]>('/api/v1/genres/tv');
  const { data: languages } = useSWR<Language[]>('/api/v1/languages');
  const { data: movieCertifications } = useSWR<CertificationResponse>(
    '/api/v1/certifications/movie'
  );
  const { data: tvCertifications } = useSWR<CertificationResponse>(
    '/api/v1/certifications/tv'
  );
  const region = currentSettings.discoverRegion || 'US';

  const genreOptions = useMemo(() => {
    const genres = new Map<number, string>();
    [...(movieGenres ?? []), ...(tvGenres ?? [])].forEach((genre) =>
      genres.set(genre.id, genre.name)
    );
    return [...genres].map(([value, label]) => ({ value, label }));
  }, [movieGenres, tvGenres]);
  const languageOptions = useMemo(
    () =>
      (languages ?? []).map((language) => ({
        value: language.iso_639_1,
        label: Intl.DisplayNames
          ? (new Intl.DisplayNames(undefined, { type: 'language' }).of(
              language.iso_639_1
            ) ?? language.english_name)
          : language.english_name,
      })),
    [languages]
  );
  const ratingOptions = useMemo(
    () => [
      ...(movieCertifications?.certifications[region] ?? []).map((rating) => ({
        value: `movie:${rating.certification}`,
        label: `${intl.formatMessage(messages.movie)} · ${rating.certification}`,
      })),
      ...(tvCertifications?.certifications[region] ?? []).map((rating) => ({
        value: `tv:${rating.certification}`,
        label: `${intl.formatMessage(messages.series)} · ${rating.certification}`,
      })),
    ],
    [intl, movieCertifications, region, tvCertifications]
  );

  const rows = [
    [
      'includeGenreIds',
      intl.formatMessage(messages.includeGenres),
      genreOptions,
    ],
    [
      'excludeGenreIds',
      intl.formatMessage(messages.excludeGenres),
      genreOptions,
    ],
    [
      'includeOriginalLanguages',
      intl.formatMessage(messages.includeLanguages),
      languageOptions,
    ],
    [
      'excludeOriginalLanguages',
      intl.formatMessage(messages.excludeLanguages),
      languageOptions,
    ],
    [
      'includeContentRatings',
      intl.formatMessage(messages.includeRatings),
      ratingOptions,
    ],
    [
      'excludeContentRatings',
      intl.formatMessage(messages.excludeRatings),
      ratingOptions,
    ],
  ] as const;
  return (
    <>
      <div className="form-row">
        <h4 className="text-lg font-semibold">
          {intl.formatMessage(messages.title)}
        </h4>
        <p className="form-input-area text-sm text-gray-400">
          {intl.formatMessage(messages.help)}
        </p>
      </div>
      <div className="grid gap-x-6 md:grid-cols-2">
        {rows.map(([field, label, options]) => (
          <div className="mb-4 min-w-0" key={field}>
            <label className="text-label mb-2 block">{label}</label>
            <MultiSelect
              options={options}
              value={values[field]}
              onChange={(selected) => setFieldValue(field, selected)}
            />
          </div>
        ))}
        {(
          [
            [
              'minimumTmdbScore',
              intl.formatMessage(messages.minimumScore),
              '0.1',
            ],
            [
              'minimumTmdbVotes',
              intl.formatMessage(messages.minimumVotes),
              '1',
            ],
          ] as const
        ).map(([field, label, step]) => (
          <div className="mb-4 min-w-0" key={field}>
            <label htmlFor={field} className="text-label mb-2 block">
              {label}
            </label>
            <input
              id={field}
              className="short"
              type="text"
              inputMode={step === '1' ? 'numeric' : 'decimal'}
              value={values[field]}
              onChange={(event) =>
                setFieldValue(field, Number(event.target.value))
              }
            />
            {touched[field] && errors[field] && (
              <div className="error">{String(errors[field])}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
};

export default FreshContentFilters;
