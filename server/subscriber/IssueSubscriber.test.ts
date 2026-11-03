import { IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import axios from 'axios';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

describe('existing subtitle issue notifications', () => {
  for (const [season, episode] of [
    [0, 1],
    [2, 4],
    [2, 0],
    [0, 0],
  ]) {
    it(`preserves attribution and correctly describes scope ${season}/${episode}`, async () => {
      const originalCreate = axios.create;
      const transport = mock.method(
        axios,
        'create',
        (config: Parameters<typeof axios.create>[0]) =>
          originalCreate({
            ...config,
            adapter: async (requestConfig) => ({
              data: {
                id: 123,
                name: 'Test Series',
                overview: 'Series overview',
                poster_path: '/poster.jpg',
                first_air_date: '2025-01-01',
              },
              status: 200,
              statusText: 'OK',
              headers: {},
              config: requestConfig,
            }),
          })
      );
      const send = mock.method(
        notificationManager,
        'sendNotification',
        () => undefined
      );
      try {
        const reporter = new User({ id: 42, permissions: 4194304 });
        const issue = new Issue({
          id: 1,
          issueType: IssueType.SUBTITLES,
          media: new Media({ tmdbId: 123, mediaType: MediaType.TV }),
          createdBy: reporter,
          problemSeason: season,
          problemEpisode: episode,
          comments: [
            new IssueComment({
              id: 1,
              user: reporter,
              message: 'Generated report',
            }),
          ],
        });
        const subscriber = new IssueSubscriber() as unknown as {
          sendIssueNotification: (
            entity: Issue,
            type: Notification
          ) => Promise<void>;
        };
        await subscriber.sendIssueNotification(
          issue,
          Notification.ISSUE_CREATED
        );
        assert.equal(send.mock.callCount(), 1);
        const [kind, payload] = send.mock.calls[0].arguments;
        assert.ok(payload);
        assert.equal(kind, Notification.ISSUE_CREATED);
        assert.equal(payload.issue?.createdBy.id, reporter.id);
        assert.equal(payload.message, 'Generated report');
        assert.equal(payload.notifyAdmin, true);
        assert.equal(payload.notifySystem, true);
        assert.deepEqual(
          payload.extra,
          season > 0 || episode > 0
            ? [
                { name: 'Affected Season', value: String(season) },
                ...(episode > 0
                  ? [{ name: 'Affected Episode', value: String(episode) }]
                  : []),
              ]
            : []
        );
      } finally {
        send.mock.restore();
        transport.mock.restore();
      }
    });
  }
});
