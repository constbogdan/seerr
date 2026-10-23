import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryFile, LibraryPresence } from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import {
  classifyMovieLibraryStatusByTmdbIds,
  movieLibraryStatusCaseSql,
} from '@server/lib/watchlistLibraryStatus';
import { getLocalMovieCollectionMembership } from '@server/lib/watchlistRouletteCollections';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

setupTestDb();

const observedAt = new Date('2026-10-23T00:00:00.000Z');
let presenceSequence = 0;

const canonicalMovie = async (
  tmdbId: number,
  options: {
    collectionId?: number | null;
    hydrated?: boolean;
    currentMediaId?: number;
  } = {}
): Promise<CanonicalMedia> => {
  const canonical = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: `Movie ${tmdbId}`,
      currentMediaId: options.currentMediaId,
      tmdbCollectionId: options.collectionId,
      collectionMembershipHydratedAt: options.hydrated ? observedAt : null,
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: canonical.id,
      mediaType: LibraryMediaType.MOVIE,
      provider: 'tmdb',
      sourceScope: '',
      value: String(tmdbId),
    })
  );
  return canonical;
};

const presence = (
  canonicalMediaId: number,
  input: Partial<LibraryPresence> & Pick<LibraryPresence, 'sourceSystem'>
) =>
  getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId,
      sourceScope: 'roulette-library-status-test',
      sourceItemId: `${input.sourceSystem}:${canonicalMediaId}:${presenceSequence++}`,
      sourceGeneration: '1',
      firstObservedAt: observedAt,
      isCurrent: false,
      ...input,
    })
  );

describe('Movie historical Library Status classification', () => {
  it('compiles the shared classifier expression with PostgreSQL parameters', () => {
    const postgres = new DataSource({
      type: 'postgres',
      url: 'postgres://unused:unused@127.0.0.1/unused',
    });
    const [sql, parameters] = postgres
      .createQueryBuilder()
      .select('canonical.id', 'canonicalMediaId')
      .addSelect(
        movieLibraryStatusCaseSql('canonical.id', ':physicalTrue'),
        'libraryStatus'
      )
      .from('canonical_media', 'canonical')
      .where('canonical.id IN (:...canonicalIds)', { canonicalIds: [1, 2] })
      .setParameter('physicalTrue', true)
      .getQueryAndParameters();

    assert.match(sql, /CASE WHEN EXISTS/);
    assert.match(sql, /\$1/);
    assert.doesNotMatch(sql, /\?/);
    assert.equal(
      parameters.filter((parameter) => parameter === true).length,
      1
    );
    assert.deepEqual(parameters.slice(-2), [1, 2]);
  });

  it('batches exact identities with Active precedence and retained-file history', async () => {
    const active = await canonicalMovie(1);
    await presence(active.id, {
      sourceSystem: 'radarr',
      isCurrent: true,
      servarrHasFile: true,
    });

    const archived = await canonicalMovie(2);
    await presence(archived.id, {
      sourceSystem: 'radarr',
      isCurrent: false,
      servarrHasFile: true,
    });

    const fileless = await canonicalMovie(3);
    await presence(fileless.id, {
      sourceSystem: 'radarr',
      isCurrent: true,
      servarrHasFile: false,
    });

    const retained = await canonicalMovie(4);
    const retainedPresence = await presence(retained.id, {
      sourceSystem: 'radarr',
      isCurrent: false,
      servarrHasFile: false,
    });
    await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: retainedPresence.id,
        sourceSystem: 'radarr',
        sourceScope: 'roulette-library-status-test',
        sourceFileId: 'retained-file',
        sourceGeneration: '1',
        firstObservedAt: observedAt,
        isCurrent: false,
      })
    );

    const jellyfin = await canonicalMovie(5);
    await presence(jellyfin.id, {
      sourceSystem: 'jellyfin',
      isCurrent: true,
      jellyfinVisible: true,
    });

    const precedence = await canonicalMovie(6);
    await presence(precedence.id, {
      sourceSystem: 'radarr',
      isCurrent: false,
      servarrHasFile: true,
    });
    await presence(precedence.id, {
      sourceSystem: 'jellyfin',
      isCurrent: true,
      jellyfinVisible: true,
    });

    const fallbackMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 7,
        status: MediaStatus.AVAILABLE,
      })
    );
    const fallback = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Compatibility fallback',
        currentMediaId: fallbackMedia.id,
      })
    );
    await presence(fallback.id, {
      sourceSystem: 'radarr',
      isCurrent: true,
      servarrHasFile: true,
    });

    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Typed Series identity',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: series.id,
        mediaType: LibraryMediaType.SERIES,
        provider: 'tmdb',
        sourceScope: '',
        value: '9',
      })
    );
    await presence(series.id, {
      sourceSystem: 'sonarr',
      isCurrent: true,
      servarrHasFile: true,
    });

    const ids = Array.from({ length: 410 }, (_, index) => index + 1);
    const statuses = await classifyMovieLibraryStatusByTmdbIds([
      ...ids,
      0,
      -1,
      1.5,
    ]);
    assert.equal(statuses.size, 410);
    assert.equal(statuses.get(1), 'active');
    assert.equal(statuses.get(2), 'archived');
    assert.equal(statuses.get(3), 'absent');
    assert.equal(statuses.get(4), 'archived');
    assert.equal(statuses.get(5), 'active');
    assert.equal(statuses.get(6), 'active');
    assert.equal(statuses.get(7), 'active');
    assert.equal(statuses.get(8), 'absent');
    assert.equal(statuses.get(9), 'absent');
    assert.equal(statuses.has(0), false);
    assert.equal(statuses.has(-1), false);
    assert.equal(statuses.has(1.5), false);
  });

  it('uses hydrated local membership before provider resolution', async () => {
    await canonicalMovie(100, { collectionId: 900, hydrated: true });
    await canonicalMovie(101, { collectionId: null, hydrated: true });
    await canonicalMovie(102, { collectionId: 901, hydrated: false });
    const fallbackMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 103,
        status: MediaStatus.UNKNOWN,
      })
    );
    await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        currentMediaId: fallbackMedia.id,
        tmdbCollectionId: 902,
        collectionMembershipHydratedAt: observedAt,
      })
    );

    assert.deepEqual(await getLocalMovieCollectionMembership(100), {
      kind: 'collection',
      collectionId: 900,
    });
    assert.deepEqual(await getLocalMovieCollectionMembership(101), {
      kind: 'standalone',
    });
    assert.deepEqual(await getLocalMovieCollectionMembership(102), {
      kind: 'unresolved',
    });
    assert.deepEqual(await getLocalMovieCollectionMembership(103), {
      kind: 'collection',
      collectionId: 902,
    });
    assert.deepEqual(await getLocalMovieCollectionMembership(999), {
      kind: 'unresolved',
    });
  });
});
