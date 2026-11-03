import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { LibraryFile, LibraryFileEpisode } from '@server/entity/LibraryHistory';
import type {
  LibraryBulkActionTarget,
  LibrarySelectionSizeResponse,
} from '@server/interfaces/api/libraryInterfaces';
import { validateLibraryBulkActionTargets } from '@server/lib/libraryBulkActions';

export interface LibrarySelectionSizeRow {
  canonicalMediaId: string | number;
  fileId: string | number;
  sizeBytes: string | number | null;
  seasonNumber: string | number | null;
}

export interface LibrarySelectionSizeDependencies {
  validateTargets: (targets: LibraryBulkActionTarget[]) => Promise<void>;
  loadRows: (canonicalMediaIds: number[]) => Promise<LibrarySelectionSizeRow[]>;
}

const loadCurrentSelectionFileRowChunk = async (
  canonicalMediaIds: number[]
): Promise<LibrarySelectionSizeRow[]> =>
  getRepository(LibraryFile)
    .createQueryBuilder('selection_file')
    .innerJoin('selection_file.libraryPresence', 'selection_presence')
    .leftJoin(
      LibraryFileEpisode,
      'selection_link',
      'selection_link.libraryFileId = selection_file.id'
    )
    .leftJoin(
      CanonicalEpisode,
      'selection_episode',
      'selection_episode.id = selection_link.canonicalEpisodeId'
    )
    .leftJoin(
      CanonicalSeason,
      'selection_season',
      'selection_season.id = selection_episode.seasonId'
    )
    .select('selection_presence.canonicalMediaId', 'canonicalMediaId')
    .addSelect('selection_file.id', 'fileId')
    .addSelect('selection_file.sizeBytes', 'sizeBytes')
    .addSelect('selection_season.seasonNumber', 'seasonNumber')
    .where('selection_presence.canonicalMediaId IN (:...canonicalMediaIds)', {
      canonicalMediaIds,
    })
    .andWhere('selection_presence.sourceSystem IN (:...sourceSystems)', {
      sourceSystems: ['radarr', 'sonarr'],
    })
    .andWhere('selection_file.isCurrent = :isCurrent', { isCurrent: true })
    .andWhere('selection_presence.isCurrent = :isCurrent', { isCurrent: true })
    .andWhere('selection_presence.servarrHasFile = :hasFile', {
      hasFile: true,
    })
    .getRawMany<LibrarySelectionSizeRow>();

const loadCurrentSelectionFileRows = async (
  canonicalMediaIds: number[]
): Promise<LibrarySelectionSizeRow[]> => {
  const rows: LibrarySelectionSizeRow[] = [];
  for (let index = 0; index < canonicalMediaIds.length; index += 400) {
    rows.push(
      ...(await loadCurrentSelectionFileRowChunk(
        canonicalMediaIds.slice(index, index + 400)
      ))
    );
  }
  return rows;
};

const defaultDependencies: LibrarySelectionSizeDependencies = {
  validateTargets: validateLibraryBulkActionTargets,
  loadRows: loadCurrentSelectionFileRows,
};

const parseKnownSize = (value: string | number | null): bigint | null => {
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

export class LibrarySelectionSizeService {
  constructor(
    private readonly dependencies: LibrarySelectionSizeDependencies = defaultDependencies
  ) {}

  public async project(
    targets: LibraryBulkActionTarget[]
  ): Promise<LibrarySelectionSizeResponse> {
    await this.dependencies.validateTargets(targets);

    const wholeMediaIds = new Set(
      targets
        .filter(({ targetType }) => targetType !== 'season')
        .map(({ canonicalMediaId }) => canonicalMediaId)
    );
    const selectedSeasons = new Set(
      targets.flatMap((target) =>
        target.targetType === 'season' && target.seasonNumber !== undefined
          ? [`${target.canonicalMediaId}:${target.seasonNumber}`]
          : []
      )
    );
    const canonicalMediaIds = [
      ...new Set(targets.map(({ canonicalMediaId }) => canonicalMediaId)),
    ];
    const rows = await this.dependencies.loadRows(canonicalMediaIds);
    const files = new Map<number, bigint | null>();

    for (const row of rows) {
      const canonicalMediaId = Number(row.canonicalMediaId);
      const selected =
        wholeMediaIds.has(canonicalMediaId) ||
        (row.seasonNumber !== null &&
          selectedSeasons.has(
            `${canonicalMediaId}:${Number(row.seasonNumber)}`
          ));
      if (!selected) continue;

      const fileId = Number(row.fileId);
      if (!Number.isSafeInteger(fileId) || files.has(fileId)) continue;
      files.set(fileId, parseKnownSize(row.sizeBytes));
    }

    let knownSize = 0n;
    let unknownFileCount = 0;
    for (const size of files.values()) {
      if (size === null) unknownFileCount += 1;
      else knownSize += size;
    }

    return {
      targets: targets.map((target) => ({ ...target })),
      sizeBytes: files.size > unknownFileCount ? knownSize.toString() : null,
      fileCount: files.size,
      unknownFileCount,
    };
  }
}

const librarySelectionSize = new LibrarySelectionSizeService();

export default librarySelectionSize;
