import { MediaType } from '@server/constants/media';
import { useCallback, useEffect, useRef, useState } from 'react';

export type DetailsWatchlistMediaType = MediaType.MOVIE | MediaType.TV;
export type DetailsWatchlistCacheKey = readonly [string, string];

export interface DetailsWatchlistTarget {
  cacheKey: DetailsWatchlistCacheKey;
  deleteUrl: string;
  identity: string;
  mediaType: DetailsWatchlistMediaType;
  tmdbId: number;
  title: string;
  userId: number;
}

const isValidIdentityPart = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && (value ?? 0) > 0;

export const parseDetailsRouteId = (
  value: string | string[] | undefined
): number | undefined => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;

  const parsed = Number(value);
  return isValidIdentityPart(parsed) ? parsed : undefined;
};

export const getDetailsWatchlistIdentity = ({
  mediaType,
  tmdbId,
  userId,
}: {
  mediaType: DetailsWatchlistMediaType;
  tmdbId?: number;
  userId?: number;
}): string | undefined =>
  isValidIdentityPart(userId) && isValidIdentityPart(tmdbId)
    ? `${userId}:${mediaType}:${tmdbId}`
    : undefined;

export const getDetailsWatchlistCacheKey = ({
  mediaType,
  tmdbId,
  userId,
}: {
  mediaType: DetailsWatchlistMediaType;
  tmdbId?: number;
  userId?: number;
}): DetailsWatchlistCacheKey | null => {
  const identity = getDetailsWatchlistIdentity({
    mediaType,
    tmdbId,
    userId,
  });
  if (!identity) return null;

  const routeType = mediaType === MediaType.TV ? 'tv' : 'movie';
  return [`/api/v1/${routeType}/${tmdbId}`, identity] as const;
};

export const createDetailsWatchlistTarget = ({
  mediaType,
  title,
  tmdbId,
  userId,
}: {
  mediaType: DetailsWatchlistMediaType;
  title: string;
  tmdbId?: number;
  userId?: number;
}): DetailsWatchlistTarget | undefined => {
  const identity = getDetailsWatchlistIdentity({
    mediaType,
    tmdbId,
    userId,
  });
  const cacheKey = getDetailsWatchlistCacheKey({
    mediaType,
    tmdbId,
    userId,
  });
  if (!identity || !cacheKey || !isValidIdentityPart(tmdbId) || !userId) {
    return undefined;
  }

  return {
    cacheKey,
    deleteUrl: `/api/v1/watchlist/${tmdbId}?mediaType=${mediaType}`,
    identity,
    mediaType,
    tmdbId,
    title,
    userId,
  };
};

export const resolveDetailsWatchlistMembership = ({
  authoritativeMembership,
  authoritativeTmdbId,
  routeTmdbId,
}: {
  authoritativeMembership?: boolean;
  authoritativeTmdbId?: number;
  routeTmdbId?: number;
}): boolean | undefined =>
  isValidIdentityPart(routeTmdbId) &&
  authoritativeTmdbId === routeTmdbId &&
  typeof authoritativeMembership === 'boolean'
    ? authoritativeMembership
    : undefined;

export const updateDetailsWatchlistMembership = <
  T extends { id: number; onUserWatchlist?: boolean },
>(
  current: T | undefined,
  target: DetailsWatchlistTarget,
  onUserWatchlist: boolean
): T | undefined =>
  current?.id === target.tmdbId ? { ...current, onUserWatchlist } : current;

export class DetailsWatchlistMutationTracker {
  private currentIdentity?: string;
  private readonly pending = new Map<string, symbol>();

  public setCurrentIdentity(identity: string | undefined): void {
    this.currentIdentity = identity;
  }

  public begin(identity: string): symbol | undefined {
    if (this.pending.has(identity)) return undefined;

    const token = Symbol(identity);
    this.pending.set(identity, token);
    return token;
  }

  public finish(identity: string, token: symbol): boolean {
    if (this.pending.get(identity) !== token) return false;

    this.pending.delete(identity);
    return true;
  }

  public isCurrent(identity: string, token: symbol): boolean {
    return (
      this.currentIdentity === identity && this.pending.get(identity) === token
    );
  }

  public isPending(identity: string | undefined): boolean {
    return identity !== undefined && this.pending.has(identity);
  }
}

export const useDetailsWatchlistMutation = (identity: string | undefined) => {
  const trackerRef = useRef(new DetailsWatchlistMutationTracker());
  const mountedRef = useRef(true);
  const [, setRevision] = useState(0);

  trackerRef.current.setCurrentIdentity(identity);

  useEffect(() => {
    const tracker = trackerRef.current;
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      tracker.setCurrentIdentity(undefined);
    };
  }, []);

  const beginMutation = useCallback((targetIdentity: string) => {
    const token = trackerRef.current.begin(targetIdentity);
    if (token && mountedRef.current) setRevision((revision) => revision + 1);
    return token;
  }, []);

  const finishMutation = useCallback(
    (targetIdentity: string, token: symbol) => {
      const finished = trackerRef.current.finish(targetIdentity, token);
      if (finished && mountedRef.current) {
        setRevision((revision) => revision + 1);
      }
    },
    []
  );

  const isCurrentMutation = useCallback(
    (targetIdentity: string, token: symbol) =>
      mountedRef.current && trackerRef.current.isCurrent(targetIdentity, token),
    []
  );

  return {
    beginMutation,
    finishMutation,
    isCurrentMutation,
    isUpdating: trackerRef.current.isPending(identity),
  };
};
