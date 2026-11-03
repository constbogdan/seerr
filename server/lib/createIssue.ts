import type { IssueType } from '@server/constants/issue';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import type { EntityManager } from 'typeorm';

// Keep attribution, the initial comment and subscribers identical for all clients.
export function createIssue(
  manager: EntityManager,
  input: {
    media: Media;
    createdBy: User;
    issueType: IssueType;
    problemSeason?: number;
    problemEpisode?: number;
    message: string;
  }
): Promise<Issue> {
  const { message, ...issue } = input;
  return manager.save(
    new Issue({
      ...issue,
      comments: [new IssueComment({ user: input.createdBy, message })],
    })
  );
}
