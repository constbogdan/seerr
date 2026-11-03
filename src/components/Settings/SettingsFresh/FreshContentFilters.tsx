import defineMessages from '@app/utils/defineMessages';
import type { TmdbGenre } from '@server/api/themoviedb/interfaces';
import type { Language } from '@server/lib/settings';
import { ErrorMessage, Field, useFormikContext } from 'formik';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';
import type { FreshSettingsDraft } from './settingsFresh';

const messages = defineMessages('components.Settings.SettingsFresh.Filters', {
  title: 'Fresh Content Filters',
  help: 'Filters only change which discoveries appear in Fresh. Discovery history is preserved.',
  excludeGenres: 'Exclude Genres',
  excludeLanguages: 'Exclude Original Languages',
  minimumScore: 'Minimum TMDB Score',
  minimumVotes: 'Minimum TMDB Votes',
});

const FreshContentFilters = () => {
  const intl = useIntl();
  const { values, setFieldValue } = useFormikContext<FreshSettingsDraft>();
  const { data: movieGenres } = useSWR<TmdbGenre[]>('/api/v1/genres/movie');
  const { data: tvGenres } = useSWR<TmdbGenre[]>('/api/v1/genres/tv');
  const { data: languages } = useSWR<Language[]>('/api/v1/languages');
  const genres = new Map(
    [...(movieGenres ?? []), ...(tvGenres ?? [])].map((genre) => [
      genre.id,
      genre.name,
    ])
  );
  const genreOptions = [...genres].map(([value, label]) => ({ value, label }));
  const names =
    typeof Intl.DisplayNames === 'function'
      ? new Intl.DisplayNames([intl.locale], { type: 'language' })
      : undefined;
  const languageOptions = (languages ?? []).map((language) => ({
    value: language.iso_639_1,
    label: names?.of(language.iso_639_1) ?? language.english_name,
  }));
  return (
    <section className="section" aria-labelledby="fresh-content-filters">
      <h3 id="fresh-content-filters" className="heading">
        {intl.formatMessage(messages.title)}
      </h3>
      <p className="description">{intl.formatMessage(messages.help)}</p>
      <div className="form-row">
        <label htmlFor="excludeGenreIds" className="text-label">
          {intl.formatMessage(messages.excludeGenres)}
        </label>
        <div className="form-input-area">
          <div className="form-input-field">
            <Select
              isMulti
              inputId="excludeGenreIds"
              aria-label={intl.formatMessage(messages.excludeGenres)}
              className="react-select-container"
              classNamePrefix="react-select"
              options={genreOptions}
              value={genreOptions.filter((option) =>
                values.excludeGenreIds.includes(option.value)
              )}
              onChange={(selected) =>
                setFieldValue(
                  'excludeGenreIds',
                  selected.map((option) => option.value)
                )
              }
            />
          </div>
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="excludeOriginalLanguages" className="text-label">
          {intl.formatMessage(messages.excludeLanguages)}
        </label>
        <div className="form-input-area">
          <div className="form-input-field">
            <Select
              isMulti
              inputId="excludeOriginalLanguages"
              aria-label={intl.formatMessage(messages.excludeLanguages)}
              className="react-select-container"
              classNamePrefix="react-select"
              options={languageOptions}
              value={languageOptions.filter((option) =>
                values.excludeOriginalLanguages.includes(option.value)
              )}
              onChange={(selected) =>
                setFieldValue(
                  'excludeOriginalLanguages',
                  selected.map((option) => option.value)
                )
              }
            />
          </div>
        </div>
      </div>
      {(['minimumTmdbScore', 'minimumTmdbVotes'] as const).map((field) => (
        <div className="form-row" key={field}>
          <label htmlFor={field} className="text-label">
            {intl.formatMessage(
              field === 'minimumTmdbScore'
                ? messages.minimumScore
                : messages.minimumVotes
            )}
          </label>
          <div className="form-input-area">
            <Field
              id={field}
              name={field}
              className="short rounded-md border border-gray-500 bg-gray-700 text-white transition duration-150 ease-in-out sm:text-sm sm:leading-5"
              type="text"
              inputMode={field === 'minimumTmdbScore' ? 'decimal' : 'numeric'}
              required
            />
            <ErrorMessage name={field} component="div" className="error" />
          </div>
        </div>
      ))}
    </section>
  );
};
export default FreshContentFilters;
