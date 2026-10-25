import type TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import type FreshWork from '@server/entity/FreshWork';
import { normalizeFreshTitle } from '@server/lib/fresh/normalize';

export type FreshIdentityProvider = Pick<
  TheMovieDb,
  | 'searchMoviesStrict'
  | 'searchTvShowsStrict'
  | 'getMovie'
  | 'getTvShow'
  | 'getByExternalId'
  | 'getDiscoveryAliases'
>;
export type FreshMatch =
  | { kind: 'resolved'; id: number; title: string }
  | { kind: 'no_match' | 'ambiguous' | 'incomplete' };
const SEARCH_PAGES = 3;
const YEAR_SEARCHES = 4;

const positiveId = (id: unknown): id is number =>
  Number.isSafeInteger(id) && Number(id) > 0;
const agreeingTitle = (source: string, title: string) =>
  normalizeFreshTitle(source) === normalizeFreshTitle(title);

/** No scoring and no blind first-result choice. Provider ordering stays intact. */
export const matchFreshIdentity = async (
  work: FreshWork,
  years: number[],
  provider: FreshIdentityProvider,
  canContinue: () => boolean = () => true
): Promise<FreshMatch> => {
  const checkBudget = () => {
    if (!canContinue()) throw new Error('metadata_budget');
  };
  checkBudget();
  const verify = async (id: number): Promise<FreshMatch> => {
    checkBudget();
    const details =
      work.mediaType === 'movie'
        ? await provider.getMovie({ movieId: id })
        : await provider.getTvShow({ tvId: id });
    const title =
      work.mediaType === 'movie'
        ? 'title' in details
          ? details.title
          : undefined
        : 'name' in details
          ? details.name
          : undefined;
    if (
      !positiveId(id) ||
      details.id !== id ||
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 300
    )
      throw new Error('invalid_identity');
    return { kind: 'resolved', id, title };
  };
  if (work.externalTmdbId) return verify(work.externalTmdbId);
  if (work.externalImdbId || (work.mediaType === 'tv' && work.externalTvdbId)) {
    const response = await provider.getByExternalId(
      work.externalImdbId
        ? { externalId: work.externalImdbId, type: 'imdb' }
        : { externalId: work.externalTvdbId!, type: 'tvdb' }
    );
    const results =
      work.mediaType === 'movie' ? response.movie_results : response.tv_results;
    if (
      !Array.isArray(results) ||
      results.some((value) => !positiveId(value.id))
    )
      throw new Error('invalid_identity');
    const ids = [...new Set(results.map((value) => value.id))];
    return ids.length === 1
      ? verify(ids[0])
      : { kind: ids.length ? 'ambiguous' : 'no_match' };
  }

  const titlesFor = (result: TmdbMovieResult | TmdbTvResult) =>
    'title' in result
      ? [result.title, result.original_title]
      : [result.name, result.original_name];
  const dateFor = (result: TmdbMovieResult | TmdbTvResult) =>
    'title' in result ? result.release_date : result.first_air_date;
  const exactTitles = (
    query: string,
    results: (TmdbMovieResult | TmdbTvResult)[]
  ) =>
    results.filter((result) =>
      titlesFor(result).some((title) => agreeingTitle(query, title))
    );
  const search = async (
    query: string,
    year?: number,
    primaryMovieYear = false
  ) => {
    const results = new Map<number, TmdbMovieResult | TmdbTvResult>();
    let expectedPages = -1;
    let expectedTotal = -1;
    let received = 0;
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      checkBudget();
      const response =
        work.mediaType === 'movie'
          ? await provider.searchMoviesStrict({
              query,
              ...(primaryMovieYear ? { year } : { releaseYear: year }),
              page,
            })
          : await provider.searchTvShowsStrict({ query, year, page });
      if (
        response.page !== page ||
        !Number.isSafeInteger(response.total_pages) ||
        response.total_pages < 0 ||
        !Number.isSafeInteger(response.total_results) ||
        response.total_results < 0 ||
        !Array.isArray(response.results) ||
        response.results.length > 20 ||
        (page > 1 &&
          (response.total_pages !== expectedPages ||
            response.total_results !== expectedTotal))
      )
        throw new Error('invalid_search');
      expectedPages = response.total_pages;
      expectedTotal = response.total_results;
      if (
        (expectedPages === 0 && expectedTotal !== 0) ||
        (expectedTotal === 0 && response.results.length)
      )
        throw new Error('invalid_search');
      for (const result of response.results) {
        const titles = titlesFor(result);
        if (
          !positiveId(result.id) ||
          (result.media_type && result.media_type !== work.mediaType) ||
          titles.some((title) => typeof title !== 'string' || !title.trim())
        )
          throw new Error('invalid_search');
        const previous = results.get(result.id);
        if (
          previous &&
          JSON.stringify([titlesFor(previous), dateFor(previous)]) !==
            JSON.stringify([titles, dateFor(result)])
        )
          throw new Error('invalid_search');
        results.set(result.id, result);
      }
      received += response.results.length;
      if (expectedPages > SEARCH_PAGES)
        return { complete: false, results: [...results.values()] };
      if (page >= expectedPages) break;
    }
    // total_results counts provider hits, not necessarily distinct identities.
    // Traverse every reported page and count every row; deduplicate only hits
    // with consistent title/date evidence (Doc's pages repeat unrelated IDs).
    if (received !== expectedTotal) throw new Error('invalid_search');
    return { complete: true, results: [...results.values()] };
  };
  const choose = async (
    query: string,
    evidence: Awaited<ReturnType<typeof search>>
  ): Promise<FreshMatch> => {
    if (!evidence.complete) return { kind: 'incomplete' };
    const exact = exactTitles(query, evidence.results);
    if (exact.length > 1) return { kind: 'ambiguous' };
    if (exact.length === 1) return verify(exact[0].id);
    // Alias checks are complete for this small candidate set, not a cherry-pick
    // of the highest-voted result. Unrelated singletons remain no-match.
    if (evidence.results.length > 3) return { kind: 'ambiguous' };
    const aliases: number[] = [];
    for (const result of evidence.results) {
      checkBudget();
      if (
        (await provider.getDiscoveryAliases(work.mediaType, result.id)).some(
          (title) => agreeingTitle(query, title)
        )
      )
        aliases.push(result.id);
    }
    if (aliases.length > 1) return { kind: 'ambiguous' };
    if (aliases.length === 1) return verify(aliases[0]);
    return { kind: 'no_match' };
  };

  if (work.mediaType === 'tv') {
    const resolveSeries = async (query: string): Promise<FreshMatch> => {
      // A release/Season year is not necessarily a premiere year. Always try
      // unfiltered identity first, retaining that result if narrowing fails.
      const evidence = await search(query);
      const result = await choose(query, evidence);
      if (
        work.year &&
        work.season !== work.year &&
        (result.kind === 'ambiguous' || result.kind === 'incomplete')
      ) {
        const narrowed = await search(query, work.year);
        const exact = exactTitles(query, narrowed.results).filter(
          (value) =>
            'first_air_date' in value &&
            value.first_air_date?.slice(0, 4) === String(work.year)
        );
        if (
          narrowed.complete &&
          exact.length === 1 &&
          (!evidence.complete ||
            evidence.results.some((value) => value.id === exact[0].id))
        )
          return verify(exact[0].id);
      }
      return result;
    };
    const result = await resolveSeries(work.title);
    if (result.kind !== 'no_match') return result;
    const baseTitle = work.title
      .match(/^(.*?)\s+Volume\s+[1-9]\d*\s*$/i)?.[1]
      .trim();
    return baseTitle ? resolveSeries(baseTitle) : result;
  }

  const searches: (number | undefined)[] = work.year
    ? [...new Set([work.year, ...years])]
    : [undefined];
  for (const year of searches.slice(0, YEAR_SEARCHES)) {
    const evidence = await search(work.title, year);
    const result = await choose(work.title, evidence);
    if (result.kind === 'resolved') return result;
    if (year && (result.kind === 'ambiguous' || result.kind === 'incomplete')) {
      const exact = exactTitles(work.title, evidence.results);
      const configuredYears = new Set([year, ...years]);
      // Do not make old-year shorts/documentaries win against a competing
      // feature in the configured window (e.g. Undertone and Whistle).
      const conflictingYear = exact.some(
        (value) =>
          'release_date' in value &&
          value.release_date?.slice(0, 4) !== String(year) &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value.release_date ?? '') ||
            configuredYears.has(Number(value.release_date?.slice(0, 4))))
      );
      const originalYear = exact.filter(
        (value) =>
          'release_date' in value &&
          value.release_date?.slice(0, 4) === String(year)
      );
      if (
        !conflictingYear &&
        (!evidence.complete || originalYear.length === 1)
      ) {
        const narrowed = await search(work.title, year, true);
        const inYear = exactTitles(work.title, narrowed.results).filter(
          (value) =>
            'release_date' in value &&
            value.release_date?.slice(0, 4) === String(year)
        );
        if (
          narrowed.complete &&
          inYear.length === 1 &&
          (!evidence.complete ||
            exact.some((value) => value.id === inYear[0].id))
        )
          return verify(inYear[0].id);
      }
    }
    if (result.kind !== 'no_match') return result;
  }
  return { kind: searches.length > YEAR_SEARCHES ? 'incomplete' : 'no_match' };
};
