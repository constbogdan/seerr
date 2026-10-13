import type { LibraryItem as LibraryItemType } from '@server/interfaces/api/libraryInterfaces';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import LibraryItem from './LibraryItem';
import {
  LIBRARY_PROGRESSIVE_BATCH_SIZE,
  getInitialLibraryMountCount,
  getNextLibraryMountCount,
} from './progressiveRendering';
import {
  getLibraryItemSelectionState,
  type LibrarySelectionKey,
  type LibrarySelectionTarget,
} from './selection';

interface LibraryResultsProps {
  items: LibraryItemType[];
  resetKey: string;
  requestedPage: number;
  responsePage: number;
  pagePending: boolean;
  selectedKeys: ReadonlySet<LibrarySelectionKey>;
  onSelectionChange: (
    target: LibrarySelectionTarget,
    selected: boolean,
    eligibleSeasonNumbers?: readonly number[]
  ) => void;
  onChanged: () => void;
}

interface ExpansionState {
  resetKey: string;
  canonicalMediaId: number | null;
}

interface MountState {
  resetKey: string;
  count: number;
}

const LibraryResults = ({
  items,
  resetKey,
  requestedPage,
  responsePage,
  pagePending,
  selectedKeys,
  onSelectionChange,
  onChanged,
}: LibraryResultsProps) => {
  const resetKeyRef = useRef(resetKey);
  resetKeyRef.current = resetKey;
  const [expansion, setExpansion] = useState<ExpansionState>({
    resetKey,
    canonicalMediaId: null,
  });
  const [mountState, setMountState] = useState<MountState>({
    resetKey,
    count: getInitialLibraryMountCount(items.length),
  });
  const mountedCount =
    mountState.resetKey === resetKey
      ? Math.min(mountState.count, items.length)
      : getInitialLibraryMountCount(items.length);
  const mounting = mountedCount < items.length;
  const expandedCanonicalMediaId =
    expansion.resetKey === resetKey ? expansion.canonicalMediaId : null;

  useEffect(() => {
    setExpansion((current) =>
      current.resetKey === resetKey && current.canonicalMediaId === null
        ? current
        : { resetKey, canonicalMediaId: null }
    );
  }, [resetKey]);

  useEffect(() => {
    if (!mounting) return;

    const frame = window.requestAnimationFrame(() => {
      startTransition(() => {
        setMountState((current) => {
          const currentCount =
            current.resetKey === resetKey
              ? Math.min(current.count, items.length)
              : getInitialLibraryMountCount(items.length);
          return {
            resetKey,
            count: getNextLibraryMountCount(currentCount, items.length),
          };
        });
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [items.length, mountedCount, mounting, resetKey]);

  const handleToggleExpanded = useCallback((canonicalMediaId: number) => {
    setExpansion((current) => {
      const currentCanonicalMediaId =
        current.resetKey === resetKeyRef.current
          ? current.canonicalMediaId
          : null;
      return {
        resetKey: resetKeyRef.current,
        canonicalMediaId:
          currentCanonicalMediaId === canonicalMediaId
            ? null
            : canonicalMediaId,
      };
    });
  }, []);

  return (
    <div
      className="space-y-3 pb-28 sm:pb-20"
      aria-busy={pagePending || mounting}
      data-library-page={responsePage}
      data-requested-page={requestedPage}
      data-library-batch-size={LIBRARY_PROGRESSIVE_BATCH_SIZE}
      data-library-mounted-count={mountedCount}
    >
      {items.slice(0, mountedCount).map((item) => {
        const expanded = expandedCanonicalMediaId === item.canonicalMediaId;
        return (
          <LibraryItem
            item={item}
            expanded={expanded}
            selectionState={getLibraryItemSelectionState(selectedKeys, item)}
            selectedKeys={expanded ? selectedKeys : undefined}
            onSelectionChange={onSelectionChange}
            onToggleExpanded={handleToggleExpanded}
            onChanged={onChanged}
            key={`${item.mediaType}:${item.canonicalMediaId}`}
          />
        );
      })}
    </div>
  );
};

export default memo(LibraryResults);
