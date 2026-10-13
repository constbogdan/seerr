import type JellyfinAPI from '@server/api/jellyfin';
import {
  MAX_JELLYFIN_ITEM_IDS,
  type JellyfinItemField,
  type JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';

export const JELLYFIN_VIEWING_USER_CONCURRENCY = 2;
export const JELLYFIN_EMPTY_ACTIVITY_TIMESTAMP = 0;

export const normalizeJellyfinActivityDate = (
  value?: string | Date | null
): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (
    Number.isNaN(date.getTime()) ||
    date.getTime() === JELLYFIN_EMPTY_ACTIVITY_TIMESTAMP
  ) {
    return null;
  }
  return date;
};

export const normalizeExactJellyfinId = (
  value?: string | null
): string | null => {
  const normalized = value?.replaceAll('-', '').trim().toLowerCase();
  return normalized && /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
};

export const chunkValues = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
};

export const runBounded = async <T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> => {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const current = values[index++];
        await worker(current);
      }
    })
  );
};

export interface JellyfinViewingClient {
  getUserItems: JellyfinAPI['getUserItems'];
}

export const getBatchedUserItems = async ({
  client,
  ids,
  userId,
  fields,
  onBatch,
}: {
  client: JellyfinViewingClient;
  ids: string[];
  userId: string;
  fields: JellyfinItemField[];
  onBatch?: () => void;
}): Promise<Map<string, JellyfinLibraryItemExtended>> => {
  const result = new Map<string, JellyfinLibraryItemExtended>();
  for (const batch of chunkValues([...new Set(ids)], MAX_JELLYFIN_ITEM_IDS)) {
    if (batch.length === 0) continue;
    const items = await client.getUserItems({ ids: batch, userId, fields });
    onBatch?.();
    for (const item of items) {
      const id = normalizeExactJellyfinId(item.Id);
      if (id) result.set(id, item);
    }
  }
  return result;
};
