import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { createIssue } from '@server/lib/createIssue';
import {
  SubtitleReportError,
  reportSubtitleIssue,
  resolveSubtitleItem,
  type SubtitleItem,
  type SubtitleTarget,
} from '@server/lib/subtitleIssue';
import { hasIssueSeason } from '@server/utils/issueScope';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource, type EntityManager } from 'typeorm';

const target: SubtitleTarget = {
  mediaType: MediaType.MOVIE,
  tmdbId: 123,
  season: 0,
  episode: 0,
  description: 'Test Movie',
};
const itemId = 'a'.repeat(32);

describe('regular Season subtitle identity validation', () => {
  const seriesId = 'b'.repeat(32);
  const parent: SubtitleItem = {
    Id: seriesId,
    Type: 'Series',
    Name: 'Authoritative Series',
    ProviderIds: { Tmdb: '123' },
  };
  const season: SubtitleItem = {
    Id: itemId,
    Type: 'Season',
    SeriesId: seriesId,
    IndexNumber: 2,
  };
  it('rejects missing, noninteger, out-of-range or Specials Season indexes without reading the parent', async () => {
    for (const index of [
      undefined,
      null,
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      2147483648,
      '2',
    ]) {
      const reads: string[] = [];
      await assert.rejects(
        resolveSubtitleItem(itemId, async (id) => {
          reads.push(id);
          return { ...season, IndexNumber: index } as SubtitleItem;
        }),
        (error: unknown) =>
          error instanceof SubtitleReportError && error.status === 422
      );
      assert.deepEqual(reads, [itemId]);
    }
  });
  it('fails closed for missing, malformed or unresolved parent Series identity', async () => {
    for (const bad of [undefined, '', 'not-a-guid']) {
      await assert.rejects(
        resolveSubtitleItem(itemId, async () => ({ ...season, SeriesId: bad })),
        { status: 422 }
      );
    }
    for (const bad of [
      { ...parent, Id: itemId },
      { ...parent, Type: 'Movie' },
      { ...parent, Type: 'Episode' },
      { ...parent, ProviderIds: {} },
      { ...parent, ProviderIds: { Tmdb: '123', TheMovieDb: '999' } },
    ]) {
      await assert.rejects(
        resolveSubtitleItem(itemId, async (id) =>
          id === itemId ? season : bad
        ),
        { status: 422 }
      );
    }
  });
});

describe('subtitle report database serialization', () => {
  it('uses a SQLite database write reservation across independent connections, not only an in-process mutex', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'subtitle-sqlite-'));
    const database = path.join(directory, 'isolated.sqlite');
    const baseOptions = dataSource.options;
    if (baseOptions.type !== 'sqlite')
      throw new Error(
        'This test requires the isolated SQLite test configuration.'
      );
    const first = new DataSource({
      ...baseOptions,
      type: 'sqlite',
      database,
      synchronize: true,
      dropSchema: false,
      subscribers: [],
      busyTimeout: 0,
    });
    const second = new DataSource({
      ...baseOptions,
      type: 'sqlite',
      database,
      synchronize: false,
      dropSchema: false,
      subscribers: [],
      busyTimeout: 0,
    });
    try {
      await first.initialize();
      await second.initialize();
      const user = await first.manager.save(
        new User({
          email: 'reporter@test.invalid',
          avatar: '',
          permissions: 4194304,
        })
      );
      const media = await first.manager.save(
        new Media({
          tmdbId: 123,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.AVAILABLE,
        })
      );
      const before = media.updatedAt;
      await first.transaction(async (manager) => {
        await manager.query('UPDATE "media" SET "id" = "id" WHERE "id" = ?', [
          media.id,
        ]);
        await createIssue(manager, {
          media,
          createdBy: user,
          issueType: IssueType.SUBTITLES,
          problemSeason: 0,
          problemEpisode: 0,
          message: 'existing report',
        });
        // A second connection cannot bypass the DB lock and create another issue.
        await assert.rejects(
          reportSubtitleIssue(
            target,
            user,
            itemId,
            'https://seerr.test',
            second
          ),
          /SQLITE_BUSY/
        );
      });
      assert.deepEqual(
        await reportSubtitleIssue(
          target,
          user,
          itemId,
          'https://seerr.test',
          second
        ),
        { status: 'already-reported' }
      );
      assert.equal(await first.manager.count(Issue), 1);
      const unchanged = await first.manager.findOneByOrFail(Media, {
        id: media.id,
      });
      assert.equal(unchanged.updatedAt.getTime(), before.getTime());
    } finally {
      if (second.isInitialized) await second.destroy();
      if (first.isInitialized) await first.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('locks the PostgreSQL parent row before checking the complete open-issue key', async () => {
    const calls: string[] = [];
    const known = new Media({ id: 7, mediaType: MediaType.MOVIE, tmdbId: 123 });
    const manager = {
      async query(sql: string, parameters?: number[]) {
        calls.push(sql);
        if (sql.includes('FOR UPDATE'))
          assert.deepEqual(parameters, [known.id]);
      },
      async findOne(entity: unknown, options: unknown) {
        assert.equal(entity, Issue);
        assert.deepEqual(options, {
          where: {
            media: { id: 7 },
            issueType: IssueType.SUBTITLES,
            status: IssueStatus.OPEN,
            problemSeason: 0,
            problemEpisode: 0,
          },
          loadEagerRelations: false,
        });
        calls.push('dedupe');
        return new Issue({ id: 9 });
      },
    } as unknown as EntityManager;
    const db = {
      options: { type: 'postgres' },
      manager: { findOne: async () => known },
      transaction: async (
        isolation: string,
        work: (manager: EntityManager) => Promise<unknown>
      ) => {
        assert.equal(isolation, 'READ COMMITTED');
        return work(manager);
      },
    } as unknown as DataSource;
    assert.deepEqual(
      await reportSubtitleIssue(
        target,
        new User({ id: 1 }),
        itemId,
        'https://seerr.test',
        db
      ),
      { status: 'already-reported' }
    );
    assert.deepEqual(calls, [
      "SET LOCAL lock_timeout = '2s'",
      'SELECT "id" FROM "media" WHERE "id" = $1 FOR UPDATE',
      'dedupe',
    ]);
  });
  it('distinguishes Series-wide scope from a Season 0 Special in existing issue presentation', () => {
    assert.equal(
      hasIssueSeason({ problemSeason: 0, problemEpisode: 0 }),
      false
    );
    assert.equal(hasIssueSeason({ problemSeason: 0, problemEpisode: 1 }), true);
    assert.equal(hasIssueSeason({ problemSeason: 2, problemEpisode: 0 }), true);
  });
});
