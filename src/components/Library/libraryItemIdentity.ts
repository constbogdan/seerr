import type { LibraryItem } from '@server/interfaces/api/libraryInterfaces';

const getLibraryItemKey = (item: LibraryItem) =>
  `${item.mediaType}:${item.canonicalMediaId}`;

const libraryItemFingerprints = new WeakMap<LibraryItem, string>();
const getLibraryItemFingerprint = (item: LibraryItem) => {
  const existing = libraryItemFingerprints.get(item);
  if (existing) return existing;
  const fingerprint = JSON.stringify(item);
  libraryItemFingerprints.set(item, fingerprint);
  return fingerprint;
};

/**
 * Retain objects from the previous response only when every API fact is equal.
 * This lets memoized cards skip presentation-only revalidations without ever
 * masking changed Library, engagement, request, removal, or Season data.
 */
export const stabilizeLibraryItems = (
  previous: readonly LibraryItem[],
  incoming: readonly LibraryItem[]
): LibraryItem[] => {
  if (previous.length === 0) return incoming as LibraryItem[];

  const previousByKey = new Map(
    previous.map((item) => [getLibraryItemKey(item), item])
  );
  let arrayChanged = previous.length !== incoming.length;
  const stabilized = incoming.map((item, index) => {
    const candidate = previousByKey.get(getLibraryItemKey(item));
    const stableItem =
      candidate &&
      getLibraryItemFingerprint(candidate) === getLibraryItemFingerprint(item)
        ? candidate
        : item;
    if (stableItem !== previous[index]) arrayChanged = true;
    return stableItem;
  });

  return arrayChanged ? stabilized : (previous as LibraryItem[]);
};
