import { createHash } from 'crypto';

export const FRESH_COMPARISON_VERSION = 2;
export const FRESH_SOURCE_EVIDENCE_VERSION = 1;

/**
 * A deterministic comparison key, never a display title. Keep this deliberately
 * narrower than fuzzy matching: equivalent punctuation/Unicode forms collapse,
 * but words are neither reordered nor approximately matched.
 */
export const normalizeFreshTitle = (title: string): string =>
  title
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/'/g, '')
    .replace(/(^|[^\p{L}\p{N}])&(?=[^\p{L}\p{N}]|$)/gu, '$1and')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

export const validReleaseId = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

export const freshSourceEvidenceKey = (value: {
  sourceTitle: string;
  year: number;
  seasonNumber: number;
  episodeNumber: number;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        FRESH_SOURCE_EVIDENCE_VERSION,
        normalizeFreshTitle(value.sourceTitle),
        value.year || 0,
        value.seasonNumber,
        value.episodeNumber,
      ])
    )
    .digest('hex');
