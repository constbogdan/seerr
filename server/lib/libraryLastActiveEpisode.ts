import {
  LibraryMediaType,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import type { CurrentViewingState } from '@server/entity/CurrentViewingState';
import type { ViewingEvidence } from '@server/entity/ViewingEvidence';
import type {
  LibraryLastActiveEpisode,
  LibraryLastActiveUser,
  LibraryUser,
} from '@server/interfaces/api/libraryInterfaces';
import {
  isQualifyingLibraryEvidence,
  normalizeLibraryDatabaseDate,
} from '@server/lib/libraryActivity';

/** Annotates existing attribution only. No ranking, queries or watched aggregation. */
export function projectLibraryLastActiveEpisodes({
  canonicalMediaId,
  mediaType,
  users,
  lastActiveAt,
  states,
  evidence,
  episodes,
  scope,
}: {
  canonicalMediaId: number;
  mediaType: LibraryMediaType;
  users: LibraryUser[];
  lastActiveAt: string | Date | null;
  states: CurrentViewingState[];
  evidence: ViewingEvidence[];
  episodes: {
    canonicalMediaId: number;
    canonicalEpisodeId: number;
    seasonNumber: number;
    episodeNumber: number;
  }[];
  scope: 'current' | 'archive';
}): LibraryLastActiveUser[] {
  const time = normalizeLibraryDatabaseDate(lastActiveAt)?.getTime();
  if (
    mediaType !== LibraryMediaType.SERIES ||
    time === undefined ||
    !users.length
  )
    return users;
  const available = new Map(
    episodes
      .filter((e) => e.canonicalMediaId === canonicalMediaId)
      .map((e) => [e.canonicalEpisodeId, e])
  );
  const candidates = new Map<
    number,
    {
      id: number;
      classification?: LibraryLastActiveEpisode['classification'];
    }[]
  >();
  const append = (
    userId: number | null | undefined,
    parent: number | null | undefined,
    id: number | null | undefined,
    at: Date | null | undefined,
    classification?: LibraryLastActiveEpisode['classification']
  ) => {
    if (
      !userId ||
      parent !== canonicalMediaId ||
      !id ||
      !available.has(id) ||
      normalizeLibraryDatabaseDate(at)?.getTime() !== time
    )
      return;
    const rows = candidates.get(userId) ?? [];
    rows.push({ id, classification });
    candidates.set(userId, rows);
  };
  if (scope === 'current')
    for (const state of states) {
      if (!state.played && (state.progressBasisPoints ?? 0) <= 0) continue;
      // Played is a current snapshot, not an event classification at lastPlayedAt.
      append(
        state.viewer?.user?.id,
        state.canonicalMediaId,
        state.canonicalEpisodeId,
        state.lastPlayedAt
      );
    }
  for (const row of evidence) {
    if (!row.viewerId || !isQualifyingLibraryEvidence(row)) continue;
    append(
      row.viewer?.user?.id,
      row.canonicalMediaId,
      row.canonicalEpisodeId,
      row.observedEndAt ?? row.observedAt,
      row.completionClassification === ViewingCompletionClassification.CONFIRMED
        ? 'watched'
        : row.completionClassification ===
            ViewingCompletionClassification.PARTIAL
          ? 'partial'
          : undefined
    );
  }
  return users.map((user) => {
    const rows = candidates.get(user.id) ?? [];
    const ids = new Set(rows.map((row) => row.id));
    // A timestamp shared by different Episodes is not an authoritative choice.
    if (ids.size !== 1) return user;
    const episode = available.get(rows[0].id)!;
    if (
      !Number.isSafeInteger(episode.seasonNumber) ||
      episode.seasonNumber < 0 ||
      !Number.isSafeInteger(episode.episodeNumber) ||
      episode.episodeNumber <= 0
    )
      return user;
    const classifications = new Set(rows.map((row) => row.classification));
    const classification =
      classifications.size === 1 ? rows[0].classification : undefined;
    return {
      ...user,
      episode: {
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        ...(classification ? { classification } : {}),
      },
    };
  });
}
