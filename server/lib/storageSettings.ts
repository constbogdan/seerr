import type { DiskSpace, RootFolder } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type {
  OverflowProvider,
  OverflowSettings,
  OverflowVolumeRoute,
} from '@server/constants/overflow';
import {
  BYTES_PER_OVERFLOW_GB,
  resolveOverflowRoot,
} from '@server/constants/overflow';
import {
  RemovalExecutionState,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import {
  STORAGE_ROOT_COLOR_PALETTE,
  normalizeStorageRootColor,
} from '@server/constants/storageRoot';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { RemovalExecution } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import type {
  AllSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { In } from 'typeorm';

export interface StorageLocation {
  id: string;
  provider: OverflowProvider;
  serviceId: number;
  serviceName: string;
  rootFolderId: number | null;
  name: string;
  path: string;
  color: string | null;
  isAnimation?: boolean;
  diskSpacePath: string | null;
  totalSpace: number | null;
  usedSpace: number | null;
  freeSpace: number | null;
  usedPercentage: number | null;
  accessible: boolean;
  routable: boolean;
}

export interface StorageUsageSegment {
  id: string;
  locationId: string;
  provider: OverflowProvider;
  serviceId: number;
  serviceName: string;
  rootFolderId: number | null;
  label: string;
  path: string;
  color: string;
  indexedUsageBytes: string;
  percentage: number | null;
  pendingRemovalBytes: string | null;
  pendingRemovalPercentage: number | null;
}

export interface PhysicalVolume {
  id: string;
  name: string;
  volumeKey: string | null;
  locationIds: string[];
  segments: StorageUsageSegment[];
  totalSpace: number | null;
  usedSpace: number | null;
  freeSpace: number | null;
  usedPercentage: number | null;
  knownLibraryUsageBytes: string;
  pendingRemovalBytes: string | null;
  pendingRemovalPercentage: number | null;
  pendingRemovalAvailable: boolean;
  pendingRemovalComplete: boolean;
  omittedRemovalScheduleCount: number;
  unaccountedUsageBytes: string | null;
  provisionedSpaceBytes: string | null;
  usageExceedsPhysical: boolean;
  capacityReadingsDiffer: boolean;
  accessible: boolean;
}

export interface StorageInstanceStatus {
  provider: OverflowProvider;
  serviceId: number;
  serviceName: string;
  available: boolean;
  capacityAvailable: boolean;
}

export interface StorageDiscoveryResult {
  locations: StorageLocation[];
  volumes: PhysicalVolume[];
  instances: StorageInstanceStatus[];
  refreshedAt: string;
}

interface StoredRootSnapshot {
  sourceRootId: number;
  path: string;
  displayName: string | null;
  color: string | null;
  isAnimation?: boolean;
}

export interface StorageRootUsage {
  provider: OverflowProvider;
  serviceId: number;
  sourceRootId: number;
  sizeBytes: string;
  pendingRemovalBytes?: string | null;
}

export interface StorageUsageProjection {
  roots: StorageRootUsage[];
  pendingRemovalAvailable: boolean;
  pendingRemovalComplete: boolean;
  omittedScheduleCount: number;
}

export interface StorageDiscoveryDependencies {
  getStoredRoots: (
    provider: OverflowProvider,
    serviceId: number
  ) => Promise<StoredRootSnapshot[]>;
  getFreshRoots: (
    provider: OverflowProvider,
    settings: RadarrSettings | SonarrSettings
  ) => Promise<RootFolder[]>;
  getFreshDiskSpace: (
    provider: OverflowProvider,
    settings: RadarrSettings | SonarrSettings
  ) => Promise<DiskSpace[]>;
  getLibraryUsage: () => Promise<StorageUsageProjection>;
  now: () => Date;
}

export interface StorageFileFactRow {
  fileId: string | number;
  sizeBytes: string | number | null;
  provider: OverflowProvider | null;
  serviceId: string | number | null;
  sourceRootId: string | number | null;
  canonicalMediaId: string | number;
  sourceSystem: string;
  sourceScope: string;
  servarrHasFile: boolean | string | number | null;
  seasonNumber: string | number | null;
}

export interface PendingRemovalScheduleFact {
  id: number;
  canonicalMediaId: number;
  targetType: RemovalTargetType;
  seasonNumber?: number | null;
  sourceSystem: 'radarr' | 'sonarr';
  sourceScope: string;
}

const loadCurrentStorageFileFacts = async (): Promise<StorageFileFactRow[]> =>
  getRepository(LibraryFile)
    .createQueryBuilder('file')
    .innerJoin(
      LibraryPresence,
      'presence',
      'presence.id = file.libraryPresenceId'
    )
    .leftJoin(StorageRoot, 'root', 'root.id = file.storageRootId')
    .leftJoin(
      LibraryFileEpisode,
      'file_episode',
      'file_episode.libraryFileId = file.id'
    )
    .leftJoin(
      CanonicalEpisode,
      'episode',
      'episode.id = file_episode.canonicalEpisodeId'
    )
    .leftJoin(CanonicalSeason, 'season', 'season.id = episode.seasonId')
    .select('file.id', 'fileId')
    .addSelect('file.sizeBytes', 'sizeBytes')
    .addSelect('root.servarrType', 'provider')
    .addSelect('root.serviceId', 'serviceId')
    .addSelect('root.sourceRootId', 'sourceRootId')
    .addSelect('presence.canonicalMediaId', 'canonicalMediaId')
    .addSelect('presence.sourceSystem', 'sourceSystem')
    .addSelect('presence.sourceScope', 'sourceScope')
    .addSelect('presence.servarrHasFile', 'servarrHasFile')
    .addSelect('season.seasonNumber', 'seasonNumber')
    .where('file.isCurrent = :current', { current: true })
    .andWhere('presence.isCurrent = :current', { current: true })
    .andWhere('presence.sourceSystem IN (:...sourceSystems)', {
      sourceSystems: ['radarr', 'sonarr'],
    })
    .getRawMany<StorageFileFactRow>();

const loadPendingRemovalSchedules = async (): Promise<
  PendingRemovalScheduleFact[]
> =>
  getRepository(RemovalSchedule).find({
    where: {
      status: In([
        RemovalScheduleStatus.ACTIVE,
        RemovalScheduleStatus.DEFERRED,
      ]),
    },
    select: {
      id: true,
      canonicalMediaId: true,
      targetType: true,
      seasonNumber: true,
      sourceSystem: true,
      sourceScope: true,
    },
  });

const loadAmbiguousRemovalExecutions = async (): Promise<{
  scheduleIds: number[];
  canonicalMediaIds: number[];
}> => {
  const rows = await getRepository(RemovalExecution)
    .createQueryBuilder('execution')
    .select('execution.scheduleId', 'scheduleId')
    .addSelect('execution.canonicalMediaId', 'canonicalMediaId')
    .where('execution.state IN (:...states)', {
      states: [
        RemovalExecutionState.PROVIDER_IN_FLIGHT,
        RemovalExecutionState.PROVIDER_ACKNOWLEDGED,
        RemovalExecutionState.PROVIDER_ABSENT,
        RemovalExecutionState.RECONCILIATION_REQUIRED,
        RemovalExecutionState.UNCERTAIN,
      ],
    })
    .getRawMany<{
      scheduleId: string | number | null;
      canonicalMediaId: string | number;
    }>();
  return {
    scheduleIds: rows.flatMap(({ scheduleId }) =>
      scheduleId === null ? [] : [Number(scheduleId)]
    ),
    canonicalMediaIds: rows.map(({ canonicalMediaId }) =>
      Number(canonicalMediaId)
    ),
  };
};

const knownSize = (value: string | number | null): bigint | null => {
  if (value === null) return null;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
    return null;
  try {
    const size = BigInt(value);
    return size >= 0n ? size : null;
  } catch {
    return null;
  }
};

const databaseBoolean = (value: boolean | string | number | null): boolean =>
  value === true || value === 1 || value === '1';

export const projectStorageUsage = ({
  fileRows,
  schedules,
  ambiguousScheduleIds = [],
  ambiguousCanonicalMediaIds = [],
  pendingRemovalAvailable = true,
}: {
  fileRows: StorageFileFactRow[];
  schedules: PendingRemovalScheduleFact[];
  ambiguousScheduleIds?: number[];
  ambiguousCanonicalMediaIds?: number[];
  pendingRemovalAvailable?: boolean;
}): StorageUsageProjection => {
  const files = new Map<
    number,
    {
      id: number;
      size: bigint | null;
      provider: OverflowProvider | null;
      serviceId: number | null;
      sourceRootId: number | null;
      canonicalMediaId: number;
      sourceSystem: string;
      sourceScope: string;
      servarrHasFile: boolean;
      seasons: Set<number>;
    }
  >();

  for (const row of fileRows) {
    const fileId = Number(row.fileId);
    if (!Number.isSafeInteger(fileId)) continue;
    const existing = files.get(fileId);
    const file = existing ?? {
      id: fileId,
      size: knownSize(row.sizeBytes),
      provider:
        row.provider === 'radarr' || row.provider === 'sonarr'
          ? row.provider
          : null,
      serviceId:
        row.serviceId === null || !Number.isSafeInteger(Number(row.serviceId))
          ? null
          : Number(row.serviceId),
      sourceRootId:
        row.sourceRootId === null ||
        !Number.isSafeInteger(Number(row.sourceRootId))
          ? null
          : Number(row.sourceRootId),
      canonicalMediaId: Number(row.canonicalMediaId),
      sourceSystem: row.sourceSystem,
      sourceScope: row.sourceScope,
      servarrHasFile: databaseBoolean(row.servarrHasFile),
      seasons: new Set<number>(),
    };
    if (row.seasonNumber !== null) {
      const seasonNumber = Number(row.seasonNumber);
      if (Number.isSafeInteger(seasonNumber)) file.seasons.add(seasonNumber);
    }
    files.set(fileId, file);
  }

  const indexedByRoot = new Map<string, bigint>();
  for (const file of files.values()) {
    if (
      file.provider === null ||
      file.serviceId === null ||
      file.sourceRootId === null ||
      file.size === null
    )
      continue;
    const key = storageRootKey(
      file.provider,
      file.serviceId,
      file.sourceRootId
    );
    indexedByRoot.set(key, (indexedByRoot.get(key) ?? 0n) + file.size);
  }

  const ambiguous = new Set(ambiguousScheduleIds);
  const ambiguousMedia = new Set(ambiguousCanonicalMediaIds);
  const pendingFileIds = new Set<number>();
  let omittedScheduleCount = 0;
  for (const schedule of schedules) {
    if (
      ambiguous.has(schedule.id) ||
      ambiguousMedia.has(schedule.canonicalMediaId)
    ) {
      omittedScheduleCount += 1;
      continue;
    }
    let scheduleIncomplete = false;
    const candidates = [...files.values()].filter(
      (file) =>
        file.canonicalMediaId === schedule.canonicalMediaId &&
        file.sourceSystem === schedule.sourceSystem &&
        file.sourceScope === schedule.sourceScope
    );
    for (const file of candidates) {
      if (!file.servarrHasFile) {
        scheduleIncomplete = true;
        continue;
      }
      let selected = schedule.targetType !== RemovalTargetType.SEASON;
      if (schedule.targetType === RemovalTargetType.SEASON) {
        selected =
          schedule.seasonNumber !== null &&
          schedule.seasonNumber !== undefined &&
          file.seasons.size > 0 &&
          [...file.seasons].every(
            (seasonNumber) => seasonNumber === schedule.seasonNumber
          );
        if (
          file.seasons.size === 0 ||
          (file.seasons.has(schedule.seasonNumber ?? -1) && !selected)
        ) {
          scheduleIncomplete = true;
        }
      }
      if (!selected) continue;
      const serviceMatch = schedule.sourceScope.match(/^service:(\d+)$/);
      if (
        file.size === null ||
        file.provider === null ||
        file.serviceId === null ||
        file.sourceRootId === null ||
        file.provider !== schedule.sourceSystem ||
        !serviceMatch ||
        file.serviceId !== Number(serviceMatch[1])
      ) {
        scheduleIncomplete = true;
        continue;
      }
      pendingFileIds.add(file.id);
    }
    if (scheduleIncomplete) omittedScheduleCount += 1;
  }

  const pendingByRoot = new Map<string, bigint>();
  for (const fileId of pendingFileIds) {
    const file = files.get(fileId);
    if (
      !file ||
      file.size === null ||
      file.provider === null ||
      file.serviceId === null ||
      file.sourceRootId === null
    )
      continue;
    const key = storageRootKey(
      file.provider,
      file.serviceId,
      file.sourceRootId
    );
    pendingByRoot.set(key, (pendingByRoot.get(key) ?? 0n) + file.size);
  }

  const rootKeys = new Set([...indexedByRoot.keys(), ...pendingByRoot.keys()]);
  return {
    roots: [...rootKeys]
      .map((key): StorageRootUsage => {
        const [provider, serviceId, sourceRootId] = key.split(':');
        return {
          provider: provider as OverflowProvider,
          serviceId: Number(serviceId),
          sourceRootId: Number(sourceRootId),
          sizeBytes: String(indexedByRoot.get(key) ?? 0n),
          pendingRemovalBytes: pendingRemovalAvailable
            ? String(pendingByRoot.get(key) ?? 0n)
            : null,
        };
      })
      .sort((left, right) =>
        `${left.provider}:${left.serviceId}:${left.sourceRootId}`.localeCompare(
          `${right.provider}:${right.serviceId}:${right.sourceRootId}`
        )
      ),
    pendingRemovalAvailable,
    pendingRemovalComplete:
      pendingRemovalAvailable && omittedScheduleCount === 0,
    omittedScheduleCount,
  };
};

export const loadStorageUsageProjection =
  async (): Promise<StorageUsageProjection> => {
    const fileRows = await loadCurrentStorageFileFacts();
    try {
      const [schedules, ambiguousExecutions] = await Promise.all([
        loadPendingRemovalSchedules(),
        loadAmbiguousRemovalExecutions(),
      ]);
      return projectStorageUsage({
        fileRows,
        schedules,
        ambiguousScheduleIds: ambiguousExecutions.scheduleIds,
        ambiguousCanonicalMediaIds: ambiguousExecutions.canonicalMediaIds,
      });
    } catch {
      return projectStorageUsage({
        fileRows,
        schedules: [],
        pendingRemovalAvailable: false,
      });
    }
  };

export const loadLibraryStorageUsage = async (): Promise<StorageRootUsage[]> =>
  (await loadStorageUsageProjection()).roots;

const defaultDependencies: StorageDiscoveryDependencies = {
  getStoredRoots: async (provider, serviceId) => {
    const roots = await getRepository(StorageRoot).findBy({
      servarrType: provider,
      serviceId,
    });
    return roots.flatMap((root) =>
      typeof root.pathSnapshot === 'string' && root.pathSnapshot.trim()
        ? [
            {
              sourceRootId: root.sourceRootId,
              path: root.pathSnapshot,
              displayName: root.displayName ?? null,
              color: normalizeStorageRootColor(root.color),
              isAnimation: root.isAnimation,
            },
          ]
        : []
    );
  },
  getFreshRoots: async (provider, settings) => {
    const options = {
      apiKey: settings.apiKey,
      url:
        provider === 'radarr'
          ? RadarrAPI.buildUrl(settings, '/api/v3')
          : SonarrAPI.buildUrl(settings, '/api/v3'),
    };
    return provider === 'radarr'
      ? new RadarrAPI(options).getRootFoldersFresh()
      : new SonarrAPI(options).getRootFoldersFresh();
  },
  getFreshDiskSpace: async (provider, settings) => {
    const options = {
      apiKey: settings.apiKey,
      url:
        provider === 'radarr'
          ? RadarrAPI.buildUrl(settings, '/api/v3')
          : SonarrAPI.buildUrl(settings, '/api/v3'),
    };
    return provider === 'radarr'
      ? new RadarrAPI(options).getDiskSpaceFresh()
      : new SonarrAPI(options).getDiskSpaceFresh();
  },
  getLibraryUsage: loadStorageUsageProjection,
  now: () => new Date(),
};

const normalizedPath = (value: string): string =>
  value.trim().replace(/[\\/]+$/, '');

const fallbackName = (path: string, provider: OverflowProvider): string =>
  normalizedPath(path).split(/[\\/]/).filter(Boolean).at(-1) ?? provider;

const validCapacity = (
  disk: Pick<DiskSpace, 'totalSpace' | 'freeSpace'>
): { totalSpace: number; freeSpace: number } | null => {
  if (
    !Number.isFinite(disk.totalSpace) ||
    !Number.isFinite(disk.freeSpace) ||
    disk.totalSpace <= 0 ||
    disk.freeSpace < 0 ||
    disk.freeSpace > disk.totalSpace
  ) {
    return null;
  }
  return { totalSpace: disk.totalSpace, freeSpace: disk.freeSpace };
};

const matchingDiskSpace = (
  rootPath: string,
  disks: DiskSpace[]
): DiskSpace | null => {
  const normalizedRoot = normalizedPath(rootPath).toLowerCase();
  return (
    disks
      .filter((disk) => {
        const path = normalizedPath(disk.path).toLowerCase();
        return (
          path.length > 0 &&
          (normalizedRoot === path ||
            normalizedRoot.startsWith(`${path}/`) ||
            normalizedRoot.startsWith(`${path}\\`))
        );
      })
      .sort(
        (left, right) =>
          normalizedPath(right.path).length - normalizedPath(left.path).length
      )[0] ?? null
  );
};

export const storageLocationId = (
  provider: OverflowProvider,
  serviceId: number,
  rootFolderId: number | null,
  path: string
): string =>
  rootFolderId === null
    ? `${provider}:${serviceId}:path:${encodeURIComponent(normalizedPath(path))}`
    : `${provider}:${serviceId}:root:${rootFolderId}`;

const physicalVolumeKey = (path: string): string | null => {
  const match = normalizedPath(path).match(/^[/\\](volume\d+)(?:[/\\]|$)/i);
  return match?.[1].toLowerCase() ?? null;
};

const storageRootKey = (
  provider: OverflowProvider,
  serviceId: number,
  sourceRootId: number
): string => `${provider}:${serviceId}:${sourceRootId}`;

const volumeName = (key: string): string =>
  `Volume ${key.slice('volume'.length)}`;

const sumUsage = (values: string[]): bigint =>
  values.reduce((total, value) => total + BigInt(value), 0n);

const fallbackSegmentColor = (index: number, used: Set<string>): string => {
  const paletteColor = STORAGE_ROOT_COLOR_PALETTE.find(
    (candidate) => !used.has(candidate)
  );
  if (paletteColor) return paletteColor;

  // The configured palette covers normal installations. A golden-angle hue
  // keeps additional arbitrary roots visually distinct without persisting a
  // fabricated Library color.
  return `hsl(${Math.round((index * 137.508) % 360)} 70% 55%)`;
};

export const groupPhysicalVolumes = (
  locations: StorageLocation[],
  usageInput: StorageUsageProjection | StorageRootUsage[]
): PhysicalVolume[] => {
  const projection: StorageUsageProjection = Array.isArray(usageInput)
    ? {
        roots: usageInput,
        pendingRemovalAvailable: true,
        pendingRemovalComplete: true,
        omittedScheduleCount: 0,
      }
    : usageInput;
  const usage = projection.roots;
  const usageByRoot = new Map<string, string[]>();
  const pendingByRoot = new Map<string, string[]>();
  for (const row of usage) {
    if (!/^\d+$/.test(String(row.sizeBytes))) continue;
    const key = storageRootKey(row.provider, row.serviceId, row.sourceRootId);
    usageByRoot.set(key, [
      ...(usageByRoot.get(key) ?? []),
      String(row.sizeBytes),
    ]);
    if (
      projection.pendingRemovalAvailable &&
      row.pendingRemovalBytes !== null &&
      row.pendingRemovalBytes !== undefined &&
      /^\d+$/.test(String(row.pendingRemovalBytes))
    ) {
      pendingByRoot.set(key, [
        ...(pendingByRoot.get(key) ?? []),
        String(row.pendingRemovalBytes),
      ]);
    }
  }

  const groups = new Map<string, StorageLocation[]>();
  for (const location of locations) {
    const key = physicalVolumeKey(location.path);
    const groupId = key ? `physical:${key}` : `location:${location.id}`;
    groups.set(groupId, [...(groups.get(groupId) ?? []), location]);
  }

  return [...groups.entries()]
    .map(([id, members]): PhysicalVolume => {
      const key = id.startsWith('physical:')
        ? id.slice('physical:'.length)
        : null;
      const orderedMembers = [...members].sort((left, right) =>
        `${left.provider}:${left.serviceId}:${left.rootFolderId ?? left.path}`.localeCompare(
          `${right.provider}:${right.serviceId}:${right.rootFolderId ?? right.path}`
        )
      );
      const capacityCandidates = orderedMembers.flatMap((location) => {
        if (location.totalSpace === null || location.freeSpace === null) {
          return [];
        }
        const capacity = validCapacity({
          totalSpace: location.totalSpace,
          freeSpace: location.freeSpace,
        });
        return capacity ? [{ ...capacity, location }] : [];
      });
      const completeCapacity =
        capacityCandidates.length === orderedMembers.length;
      const firstCapacity = capacityCandidates[0];
      const capacityReadingsDiffer =
        completeCapacity &&
        capacityCandidates.some(
          (candidate) =>
            candidate.totalSpace !== firstCapacity?.totalSpace ||
            (key !== null &&
              physicalVolumeKey(candidate.location.diskSpacePath ?? '') !== key)
        );
      const minimumFreeSpace = capacityCandidates.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.freeSpace),
        Number.POSITIVE_INFINITY
      );
      // Missing or contradictory provider facts make physical capacity
      // unavailable. Free space is expected to drift between unsynchronized
      // provider snapshots, so use the smallest factual reading while totals
      // and physical-volume identities agree. Root-specific indexed usage
      // remains factual and visible.
      const capacity =
        completeCapacity &&
        !capacityReadingsDiffer &&
        firstCapacity &&
        Number.isFinite(minimumFreeSpace)
          ? {
              totalSpace: firstCapacity.totalSpace,
              freeSpace: minimumFreeSpace,
              usedSpace: firstCapacity.totalSpace - minimumFreeSpace,
              usedPercentage:
                ((firstCapacity.totalSpace - minimumFreeSpace) /
                  firstCapacity.totalSpace) *
                100,
            }
          : undefined;
      const usedColors = new Set<string>();
      let pendingContradiction = false;
      const segmentDrafts = orderedMembers.map((location, index) => {
        const configuredColor = normalizeStorageRootColor(location.color);
        const color =
          configuredColor && !usedColors.has(configuredColor)
            ? configuredColor
            : fallbackSegmentColor(index, usedColors);
        usedColors.add(color);
        const indexedUsage =
          location.rootFolderId === null
            ? 0n
            : sumUsage(
                usageByRoot.get(
                  storageRootKey(
                    location.provider,
                    location.serviceId,
                    location.rootFolderId
                  )
                ) ?? []
              );
        const pendingRemoval =
          !projection.pendingRemovalAvailable || location.rootFolderId === null
            ? null
            : sumUsage(
                pendingByRoot.get(
                  storageRootKey(
                    location.provider,
                    location.serviceId,
                    location.rootFolderId
                  )
                ) ?? []
              );
        const boundedPendingRemoval =
          pendingRemoval !== null && pendingRemoval > indexedUsage
            ? indexedUsage
            : pendingRemoval;
        if (pendingRemoval !== null && pendingRemoval > indexedUsage) {
          pendingContradiction = true;
        }
        return {
          location,
          color,
          indexedUsage,
          pendingRemoval: boundedPendingRemoval,
        };
      });
      const library = segmentDrafts.reduce(
        (total, segment) => total + segment.indexedUsage,
        0n
      );
      const pendingRemoval = projection.pendingRemovalAvailable
        ? segmentDrafts.reduce(
            (total, segment) => total + (segment.pendingRemoval ?? 0n),
            0n
          )
        : null;
      const physicalUsed = capacity ? BigInt(capacity.usedSpace!) : null;
      const usageExceedsPhysical =
        physicalUsed !== null && library > physicalUsed;
      const unaccounted =
        physicalUsed === null || usageExceedsPhysical
          ? null
          : physicalUsed - library;

      const segments = segmentDrafts.map(
        ({
          location,
          color,
          indexedUsage,
          pendingRemoval,
        }): StorageUsageSegment => ({
          id: location.id,
          locationId: location.id,
          provider: location.provider,
          serviceId: location.serviceId,
          serviceName: location.serviceName,
          rootFolderId: location.rootFolderId,
          label: location.name,
          path: location.path,
          color,
          indexedUsageBytes: String(indexedUsage),
          percentage:
            capacity && capacity.totalSpace !== null && capacity.totalSpace > 0
              ? (Number(indexedUsage) / capacity.totalSpace) * 100
              : null,
          pendingRemovalBytes:
            pendingRemoval === null ? null : String(pendingRemoval),
          pendingRemovalPercentage:
            pendingRemoval === null || indexedUsage === 0n
              ? null
              : Math.min(
                  100,
                  (Number(pendingRemoval) / Number(indexedUsage)) * 100
                ),
        })
      );

      return {
        id,
        name: key ? volumeName(key) : members[0].name,
        volumeKey: key,
        locationIds: segments.map((segment) => segment.locationId),
        segments,
        totalSpace: capacity?.totalSpace ?? null,
        usedSpace: capacity?.usedSpace ?? null,
        freeSpace: capacity?.freeSpace ?? null,
        usedPercentage: capacity?.usedPercentage ?? null,
        knownLibraryUsageBytes: String(library),
        pendingRemovalBytes:
          pendingRemoval === null ? null : String(pendingRemoval),
        pendingRemovalPercentage:
          pendingRemoval === null || library === 0n
            ? null
            : Math.min(100, (Number(pendingRemoval) / Number(library)) * 100),
        pendingRemovalAvailable: projection.pendingRemovalAvailable,
        pendingRemovalComplete:
          projection.pendingRemovalComplete && !pendingContradiction,
        omittedRemovalScheduleCount:
          projection.omittedScheduleCount + (pendingContradiction ? 1 : 0),
        unaccountedUsageBytes:
          unaccounted === null ? null : String(unaccounted),
        provisionedSpaceBytes: null,
        usageExceedsPhysical,
        capacityReadingsDiffer,
        accessible: Boolean(capacity),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

const discoverInstance = async (
  provider: OverflowProvider,
  instance: RadarrSettings | SonarrSettings,
  dependencies: StorageDiscoveryDependencies
): Promise<{ locations: StorageLocation[]; status: StorageInstanceStatus }> => {
  const storedRoots = await dependencies
    .getStoredRoots(provider, instance.id)
    .catch(() => []);
  const rootsById = new Map(
    storedRoots.map((root) => [root.sourceRootId, root])
  );
  let freshRoots: RootFolder[] = [];
  let freshDiskSpace: DiskSpace[] = [];
  let available = true;
  let capacityAvailable = true;
  try {
    freshRoots = await dependencies.getFreshRoots(provider, instance);
  } catch {
    available = false;
  }
  try {
    freshDiskSpace = await dependencies.getFreshDiskSpace(provider, instance);
  } catch {
    capacityAvailable = false;
  }

  // A successful root-folder response is the authority for the provider's
  // active roots. Foundation deliberately retains historical StorageRoot rows,
  // and configured defaults can lag a Servarr path migration; neither should
  // be presented as active while the provider can supply its current inventory.
  // Stored/configured paths remain a read-only outage fallback so an
  // inaccessible instance is still diagnosable without inventing capacity.
  const candidatePaths = new Set<string>();
  if (available) {
    for (const root of freshRoots) candidatePaths.add(root.path);
  } else {
    candidatePaths.add(instance.activeDirectory);
    if (provider === 'sonarr') {
      const animePath = (instance as SonarrSettings).activeAnimeDirectory;
      if (animePath) candidatePaths.add(animePath);
    }
    for (const root of storedRoots) candidatePaths.add(root.path);
  }

  const freshByPath = new Map(
    freshRoots.map((root) => [normalizedPath(root.path), root])
  );
  const storedByPath = new Map(
    storedRoots.map((root) => [normalizedPath(root.path), root])
  );
  const locations = [...candidatePaths]
    .filter((path) => normalizedPath(path).length > 0)
    .map((path): StorageLocation => {
      const normalized = normalizedPath(path);
      const fresh = freshByPath.get(normalized);
      const stored = fresh
        ? rootsById.get(fresh.id)
        : storedByPath.get(normalized);
      const rootFolderId = fresh?.id ?? stored?.sourceRootId ?? null;
      const disk = fresh ? matchingDiskSpace(normalized, freshDiskSpace) : null;
      const capacity = disk ? validCapacity(disk) : null;
      const usedSpace = capacity
        ? capacity.totalSpace - capacity.freeSpace
        : null;
      return {
        id: storageLocationId(provider, instance.id, rootFolderId, normalized),
        provider,
        serviceId: instance.id,
        serviceName: instance.name,
        rootFolderId,
        name: stored?.displayName?.trim() || fallbackName(normalized, provider),
        path: normalized,
        color: stored?.color ?? null,
        // Missing Foundation metadata is not equivalent to a confirmed
        // non-Animation root for routing purposes.
        isAnimation: stored?.isAnimation,
        diskSpacePath: disk ? normalizedPath(disk.path) : null,
        totalSpace: capacity?.totalSpace ?? null,
        usedSpace,
        freeSpace: capacity?.freeSpace ?? null,
        usedPercentage:
          usedSpace === null || !capacity
            ? null
            : (usedSpace / capacity.totalSpace) * 100,
        accessible: Boolean(fresh && capacity),
        routable: rootFolderId !== null && Boolean(fresh),
      };
    });

  const uniqueLocations = new Map<string, StorageLocation>();
  for (const location of locations) {
    const existing = uniqueLocations.get(location.id);
    if (!existing || (!existing.routable && location.routable)) {
      uniqueLocations.set(location.id, location);
    }
  }

  return {
    locations: [...uniqueLocations.values()],
    status: {
      provider,
      serviceId: instance.id,
      serviceName: instance.name,
      available,
      capacityAvailable,
    },
  };
};

export const discoverStorageLocations = async (
  settings: Pick<AllSettings, 'radarr' | 'sonarr'>,
  dependencies: StorageDiscoveryDependencies = defaultDependencies
): Promise<StorageDiscoveryResult> => {
  const [results, libraryUsage] = await Promise.all([
    Promise.all([
      ...settings.radarr.map((instance) =>
        discoverInstance('radarr', instance, dependencies)
      ),
      ...settings.sonarr.map((instance) =>
        discoverInstance('sonarr', instance, dependencies)
      ),
    ]),
    dependencies.getLibraryUsage(),
  ]);
  const locations = results
    .flatMap((result) => result.locations)
    .sort((left, right) =>
      `${left.provider}:${left.serviceName}:${left.name}`.localeCompare(
        `${right.provider}:${right.serviceName}:${right.name}`
      )
    );
  return {
    locations,
    volumes: groupPhysicalVolumes(locations, libraryUsage),
    instances: results.map((result) => result.status),
    refreshedAt: dependencies.now().toISOString(),
  };
};

export const validateOverflowRouteLocations = (
  routes: OverflowVolumeRoute[],
  discovery: StorageDiscoveryResult
): { valid: true } | { valid: false; status: 400 | 503; message: string } => {
  const volumes = new Map(
    discovery.volumes.map((volume) => [volume.id, volume])
  );
  const locations = new Map(
    discovery.locations.map((location) => [location.id, location])
  );
  for (const route of routes) {
    const source = volumes.get(route.sourceVolumeId);
    const destination = volumes.get(route.destinationVolumeId);
    if (!source || !destination) {
      return {
        valid: false,
        status: 400,
        message: 'A referenced physical volume does not exist.',
      };
    }
    if (!source.volumeKey || !destination.volumeKey) {
      return {
        valid: false,
        status: 400,
        message:
          'Overflow routing requires recognized physical-volume identities.',
      };
    }
    const sourceLocations = source.locationIds
      .map((id) => locations.get(id))
      .filter((location): location is StorageLocation =>
        Boolean(location?.routable)
      );
    const destinationLocations = destination.locationIds
      .map((id) => locations.get(id))
      .filter((location): location is StorageLocation =>
        Boolean(location?.routable)
      );
    if (!sourceLocations.length || !destinationLocations.length) {
      return {
        valid: false,
        status: 503,
        message: 'A referenced physical volume has no available Servarr roots.',
      };
    }
    for (const sourceLocation of sourceLocations) {
      const resolution = resolveOverflowRoot(
        sourceLocation,
        destinationLocations
      );
      if (resolution.status === 'source-classification-missing') {
        return {
          valid: false,
          status: 400,
          message:
            'An Overflow source root is missing Animation classification metadata.',
        };
      }
      if (resolution.status === 'destination-root-missing') {
        return {
          valid: false,
          status: 400,
          message:
            'An Overflow volume mapping has no compatible destination root.',
        };
      }
      if (resolution.status === 'destination-root-ambiguous') {
        return {
          valid: false,
          status: 400,
          message:
            'An Overflow volume mapping has multiple compatible destination roots.',
        };
      }
    }
  }
  return { valid: true };
};

export const validateOverflowThresholds = (
  routes: OverflowVolumeRoute[],
  discovery: StorageDiscoveryResult
): { valid: true } | { valid: false; status: 400 | 503; message: string } => {
  const volumes = new Map(
    discovery.volumes.map((volume) => [volume.id, volume])
  );

  for (const route of routes) {
    if (!route.enabled) continue;
    const sourceVolume = volumes.get(route.sourceVolumeId);
    if (!sourceVolume) {
      return {
        valid: false,
        status: 400,
        message: 'An Overflow source volume could not be resolved.',
      };
    }
    if (
      !sourceVolume.accessible ||
      sourceVolume.capacityReadingsDiffer ||
      sourceVolume.totalSpace === null
    ) {
      return {
        valid: false,
        status: 503,
        message:
          'An Overflow threshold cannot be validated while source capacity is unavailable.',
      };
    }
    if (route.thresholdGb * BYTES_PER_OVERFLOW_GB > sourceVolume.totalSpace) {
      return {
        valid: false,
        status: 400,
        message: 'An Overflow threshold exceeds its source volume capacity.',
      };
    }
  }

  return { valid: true };
};

export const validateSeriesPlacementVolumes = (
  settings: Pick<
    OverflowSettings,
    | 'automaticSeriesPlacement'
    | 'defaultSeriesVolumeId'
    | 'expansionSeriesVolumeId'
  >,
  discovery: StorageDiscoveryResult,
  required = settings.automaticSeriesPlacement
): { valid: true } | { valid: false; status: 400 | 503; message: string } => {
  if (!required) return { valid: true };
  if (
    !settings.defaultSeriesVolumeId ||
    !settings.expansionSeriesVolumeId ||
    settings.defaultSeriesVolumeId === settings.expansionSeriesVolumeId
  ) {
    return {
      valid: false,
      status: 400,
      message: 'Two different preferred Series volumes are required.',
    };
  }
  const locations = new Map(
    discovery.locations.map((location) => [location.id, location])
  );
  const preferredVolumes = [
    settings.defaultSeriesVolumeId,
    settings.expansionSeriesVolumeId,
  ].map((volumeId) =>
    discovery.volumes.find((candidate) => candidate.id === volumeId)
  );
  if (preferredVolumes.some((volume) => !volume)) {
    return {
      valid: false,
      status: 400,
      message: 'A preferred Series volume does not exist.',
    };
  }
  const rootsFor = (volume: PhysicalVolume) =>
    volume.locationIds
      .map((id) => locations.get(id))
      .filter(
        (location): location is StorageLocation =>
          location?.provider === 'sonarr' && location.routable
      );
  const [defaultRoots, expansionRoots] = preferredVolumes.map((volume) =>
    rootsFor(volume!)
  );
  if (!defaultRoots.length || !expansionRoots.length) {
    return {
      valid: false,
      status: 503,
      message: 'A preferred Series volume has no available Sonarr root.',
    };
  }
  for (const source of defaultRoots) {
    for (const destinations of [defaultRoots, expansionRoots]) {
      const resolution = resolveOverflowRoot(source, destinations);
      if (resolution.status === 'source-classification-missing') {
        return {
          valid: false,
          status: 400,
          message:
            'A preferred Series root is missing Animation classification metadata.',
        };
      }
      if (resolution.status === 'destination-root-missing') {
        return {
          valid: false,
          status: 400,
          message: 'A preferred Series volume has no matching Sonarr root.',
        };
      }
      if (resolution.status === 'destination-root-ambiguous') {
        return {
          valid: false,
          status: 400,
          message:
            'A preferred Series volume has multiple matching Sonarr roots.',
        };
      }
    }
  }
  return { valid: true };
};
