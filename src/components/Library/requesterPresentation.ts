import type {
  LibraryRequestFact,
  LibraryRequestSeasonFact,
  LibraryRequester,
} from '@server/interfaces/api/libraryInterfaces';

export type LibraryRequesterDetailRow =
  | {
      kind: 'request';
      request: LibraryRequestFact;
    }
  | {
      kind: 'season';
      request: LibraryRequestFact;
      season: LibraryRequestSeasonFact;
    };

export const getLibraryRequesterDetailRows = (
  requester: LibraryRequester
): LibraryRequesterDetailRow[] =>
  requester.requests.flatMap((request): LibraryRequesterDetailRow[] =>
    request.seasons.length > 0
      ? request.seasons.map((season) => ({
          kind: 'season',
          request,
          season,
        }))
      : [{ kind: 'request', request }]
  );
