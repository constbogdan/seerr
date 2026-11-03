import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(128);
const sourceId = z.string().min(1).max(255);
const optionalDate = z.string().datetime({ offset: true }).optional();
const nonnegativeInteger = z.number().int().nonnegative();

const identitySchema = z
  .object({
    provider: z.enum(['jellyfin', 'tmdb', 'tvdb', 'imdb']),
    sourceScope: z.string().max(128).default(''),
    value: z.string().min(1).max(255),
  })
  .strict();

const viewerSchema = z
  .object({
    id,
    jellyfinUserId: z.string().min(1).max(128),
  })
  .strict();

const mediaSchema = z
  .object({
    id,
    mediaType: z.enum(['movie', 'series']),
    title: z.string().max(300).optional(),
    year: z.number().int().min(1800).max(3000).optional(),
    identities: z.array(identitySchema).min(1).max(8),
  })
  .strict();

const seasonSchema = z
  .object({
    id,
    seriesId: id,
    seasonNumber: z.number().int().min(0).max(10_000),
    jellyfinItemId: z.string().min(1).max(128).optional(),
  })
  .strict();

const episodeSchema = z
  .object({
    id,
    seriesId: id,
    seasonId: id,
    episodeNumber: z.number().int().min(0).max(100_000),
    jellyfinItemId: z.string().min(1).max(128).optional(),
    airDate: z.string().date().optional(),
  })
  .strict();

const libraryFactSchema = z
  .object({
    id,
    mediaId: id,
    jellyfinItemId: z.string().min(1).max(128),
    addedAt: optionalDate,
    provenance: z.enum(['administrator-supplied-historical']).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provenance && !value.addedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Historical Added provenance requires an Added date',
      });
    }
  });

const viewingFactSchema = z
  .object({
    id: sourceId,
    viewerId: id,
    mediaId: id,
    episodeId: id.optional(),
    jellyfinItemId: z.string().min(1).max(128),
    sourceClass: z.enum([
      'historical-session',
      'historical-playback-reporting',
    ]),
    observedAt: z.string().datetime({ offset: true }),
    observedEndAt: z.string().datetime({ offset: true }),
    playbackDurationSeconds: nonnegativeInteger.max(366 * 24 * 60 * 60),
    runtimeTicks: z.string().regex(/^\d+$/).optional(),
    progressBasisPoints: nonnegativeInteger.max(10_000).optional(),
    completion: z.enum([
      'confirmed',
      'likely',
      'partial',
      'unknown',
      'no-qualifying-evidence',
    ]),
  })
  .strict();

const completionFactSchema = z
  .object({
    id: sourceId,
    viewerId: id,
    mediaId: id,
    episodeId: id.optional(),
    jellyfinItemId: z.string().min(1).max(128),
    completion: z.literal('confirmed'),
    provenance: z.literal('administrator-supplied-historical'),
  })
  .strict();

const activityFactSchema = z
  .object({
    id: sourceId,
    mediaId: id,
    jellyfinItemId: z.string().min(1).max(128),
    activityAt: z.string().datetime({ offset: true }),
    provenance: z.literal('administrator-supplied-historical'),
  })
  .strict();

const untimedEvidenceFactSchema = z
  .object({
    id: sourceId,
    viewerId: id,
    mediaId: id,
    episodeId: id.optional(),
    jellyfinItemId: z.string().min(1).max(128),
    sourceClass: z.enum([
      'historical-session',
      'historical-playback-reporting',
    ]),
    playbackDurationSeconds: nonnegativeInteger
      .max(366 * 24 * 60 * 60)
      .optional(),
    runtimeTicks: z.string().regex(/^\d+$/).optional(),
    progressBasisPoints: nonnegativeInteger.max(10_000).optional(),
    completion: z.enum([
      'confirmed',
      'likely',
      'partial',
      'unknown',
      'no-qualifying-evidence',
    ]),
    provenance: z.literal('administrator-rejected-source-timing'),
  })
  .strict();

export const wholphinHistoryContentSchema = z
  .object({
    schema: z.literal('wholphin-history-v1'),
    jellyfinServerScope: z.string().min(1).max(128),
    coverage: z
      .object({
        startedAt: optionalDate,
        endedAt: optionalDate,
      })
      .strict(),
    viewers: z.array(viewerSchema).max(10_000),
    media: z.array(mediaSchema).max(100_000),
    seasons: z.array(seasonSchema).max(100_000),
    episodes: z.array(episodeSchema).max(500_000),
    libraryFacts: z.array(libraryFactSchema).max(100_000),
    viewingFacts: z.array(viewingFactSchema).max(1_000_000),
    completionFacts: z.array(completionFactSchema).max(1_000_000).optional(),
    activityFacts: z.array(activityFactSchema).max(100_000).optional(),
    untimedEvidenceFacts: z
      .array(untimedEvidenceFactSchema)
      .max(1_000_000)
      .optional(),
  })
  .strict();

export const wholphinHistoryArtifactSchema = wholphinHistoryContentSchema
  .extend({
    datasetId: z.string().min(1).max(128),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export type WholphinHistoryContent = z.infer<
  typeof wholphinHistoryContentSchema
>;
export type WholphinHistoryArtifact = z.infer<
  typeof wholphinHistoryArtifactSchema
>;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return (
      '[' +
      value
        .map((item) => (item === undefined ? 'null' : canonicalJson(item)))
        .join(',') +
      ']'
    );
  }
  const object = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(object[key]))
      .join(',') +
    '}'
  );
};

export const createWholphinHistoryArtifact = (
  input: WholphinHistoryContent
): WholphinHistoryArtifact => {
  const content = wholphinHistoryContentSchema.parse(input);
  const digest = createHash('sha256')
    .update(canonicalJson(content))
    .digest('hex');
  return {
    ...content,
    datasetId: 'wholphin-history-v1:' + digest,
    contentHash: 'sha256:' + digest,
  };
};

export const validateWholphinHistoryArtifact = (
  input: unknown
): WholphinHistoryArtifact => {
  const artifact = wholphinHistoryArtifactSchema.parse(input);
  const { datasetId, contentHash, ...content } = artifact;
  const expected = createWholphinHistoryArtifact(content);
  if (
    datasetId !== expected.datasetId ||
    contentHash !== expected.contentHash
  ) {
    throw new Error('Wholphin history integrity check failed');
  }
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) {
      throw new Error('Duplicate Wholphin history ' + label);
    }
  };
  unique(
    artifact.viewers.map((item) => item.id),
    'viewer identity'
  );
  unique(
    artifact.viewers.map((item) => item.jellyfinUserId),
    'Jellyfin viewer identity'
  );
  unique(
    artifact.media.map((item) => item.id),
    'media identity'
  );
  unique(
    artifact.seasons.map((item) => item.id),
    'season identity'
  );
  unique(
    artifact.episodes.map((item) => item.id),
    'episode identity'
  );
  unique(
    artifact.libraryFacts.map((item) => item.id),
    'library fact identity'
  );
  unique(
    artifact.libraryFacts.map((item) => item.jellyfinItemId),
    'library source item identity'
  );
  unique(
    artifact.viewingFacts.map((item) => item.id),
    'viewing fact identity'
  );
  unique(
    (artifact.completionFacts ?? []).map((item) => item.id),
    'completion fact identity'
  );
  unique(
    (artifact.activityFacts ?? []).map((item) => item.id),
    'activity fact identity'
  );
  unique(
    (artifact.untimedEvidenceFacts ?? []).map((item) => item.id),
    'untimed evidence fact identity'
  );
  const media = new Map(artifact.media.map((item) => [item.id, item]));
  const seasons = new Map(artifact.seasons.map((item) => [item.id, item]));
  const episodes = new Map(artifact.episodes.map((item) => [item.id, item]));
  const viewers = new Set(artifact.viewers.map((item) => item.id));
  const identityOwners = new Map<string, string>();
  for (const item of artifact.media) {
    for (const identity of item.identities) {
      if (
        (identity.provider === 'tmdb' || identity.provider === 'tvdb') &&
        (!/^\d+$/.test(identity.value) || Number(identity.value) <= 0)
      ) {
        throw new Error('Invalid Wholphin history numeric provider identity');
      }
      if (identity.provider === 'imdb' && !/^tt\d+$/.test(identity.value)) {
        throw new Error('Invalid Wholphin history IMDb identity');
      }
      if (
        (identity.provider === 'jellyfin' && !identity.sourceScope) ||
        (identity.provider !== 'jellyfin' && identity.sourceScope)
      ) {
        throw new Error('Invalid Wholphin history identity scope');
      }
      const key = [
        item.mediaType,
        identity.provider,
        identity.sourceScope,
        identity.value,
      ].join(':');
      const owner = identityOwners.get(key);
      if (owner && owner !== item.id) {
        throw new Error('Contradictory Wholphin history canonical identity');
      }
      identityOwners.set(key, item.id);
    }
  }
  if (
    artifact.coverage.startedAt &&
    artifact.coverage.endedAt &&
    new Date(artifact.coverage.startedAt) > new Date(artifact.coverage.endedAt)
  ) {
    throw new Error('Invalid Wholphin history coverage range');
  }
  for (const season of artifact.seasons) {
    if (media.get(season.seriesId)?.mediaType !== 'series') {
      throw new Error('Invalid Wholphin history season reference');
    }
  }
  for (const episode of artifact.episodes) {
    const season = seasons.get(episode.seasonId);
    if (!season || season.seriesId !== episode.seriesId) {
      throw new Error('Invalid Wholphin history episode reference');
    }
  }
  for (const fact of artifact.libraryFacts) {
    if (!media.has(fact.mediaId)) {
      throw new Error('Invalid Wholphin history library reference');
    }
  }
  for (const fact of artifact.viewingFacts) {
    const mediaValue = media.get(fact.mediaId);
    const episode = fact.episodeId ? episodes.get(fact.episodeId) : undefined;
    if (
      !viewers.has(fact.viewerId) ||
      !mediaValue ||
      (fact.episodeId &&
        (!episode ||
          mediaValue.mediaType !== 'series' ||
          episode.seriesId !== fact.mediaId)) ||
      new Date(fact.observedAt) > new Date(fact.observedEndAt)
    ) {
      throw new Error('Invalid Wholphin history viewing reference');
    }
  }
  for (const fact of artifact.completionFacts ?? []) {
    const mediaValue = media.get(fact.mediaId);
    const episode = fact.episodeId ? episodes.get(fact.episodeId) : undefined;
    if (
      !viewers.has(fact.viewerId) ||
      !mediaValue ||
      (fact.episodeId &&
        (!episode ||
          mediaValue.mediaType !== 'series' ||
          episode.seriesId !== fact.mediaId))
    ) {
      throw new Error('Invalid Wholphin history completion reference');
    }
  }
  for (const fact of artifact.activityFacts ?? []) {
    if (!media.has(fact.mediaId)) {
      throw new Error('Invalid Wholphin history activity reference');
    }
  }
  for (const fact of artifact.untimedEvidenceFacts ?? []) {
    const mediaValue = media.get(fact.mediaId);
    const episode = fact.episodeId ? episodes.get(fact.episodeId) : undefined;
    if (
      !viewers.has(fact.viewerId) ||
      !mediaValue ||
      (fact.episodeId &&
        (!episode ||
          mediaValue.mediaType !== 'series' ||
          episode.seriesId !== fact.mediaId))
    ) {
      throw new Error('Invalid Wholphin history untimed evidence reference');
    }
  }
  return artifact;
};
