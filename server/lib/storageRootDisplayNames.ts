import {
  normalizeStorageRootColor,
  type StorageRootColor,
} from '@server/constants/storageRoot';
import { getRepository } from '@server/datasource';
import { StorageRoot } from '@server/entity/LibraryHistory';
import type { EntityManager } from 'typeorm';

export type ServarrType = 'radarr' | 'sonarr';

export interface StorageRootDisplayNameInput {
  sourceRootId: number;
  path: string;
  displayName?: string | null;
  isAnimation?: boolean;
  color?: string | null;
}

export interface StorageRootConfiguration {
  displayName: string | null;
  isAnimation: boolean;
  color: StorageRootColor | null;
}

export const normalizeStorageRootDisplayName = (
  value?: string | null
): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 120) : null;
};

export const storageRootDisplayLabel = (root: StorageRoot): string => {
  const displayName = normalizeStorageRootDisplayName(root.displayName);
  if (displayName) return displayName;
  const name = root.nameSnapshot?.trim();
  if (name) return name;
  const path = root.pathSnapshot?.trim().replace(/[\\/]+$/, '');
  return (
    path?.split(/[\\/]/).filter(Boolean).at(-1) ??
    `${root.servarrType} ${root.id}`
  );
};

export const storageRootDisplayNames = async (
  servarrType: ServarrType,
  serviceId: number,
  sourceRootIds: number[]
): Promise<Map<number, string | null>> => {
  if (!Number.isSafeInteger(serviceId) || sourceRootIds.length === 0) {
    return new Map();
  }
  const roots = await getRepository(StorageRoot).findBy(
    sourceRootIds.map((sourceRootId) => ({
      servarrType,
      serviceId,
      sourceRootId,
    }))
  );
  return new Map(
    roots.map((root) => [root.sourceRootId, root.displayName ?? null])
  );
};

export const storageRootConfigurations = async (
  servarrType: ServarrType,
  serviceId: number,
  sourceRootIds: number[]
): Promise<Map<number, StorageRootConfiguration>> => {
  if (!Number.isSafeInteger(serviceId) || sourceRootIds.length === 0) {
    return new Map();
  }
  const roots = await getRepository(StorageRoot).findBy(
    sourceRootIds.map((sourceRootId) => ({
      servarrType,
      serviceId,
      sourceRootId,
    }))
  );
  return new Map(
    roots.map((root) => [
      root.sourceRootId,
      {
        displayName: root.displayName ?? null,
        isAnimation: root.isAnimation,
        color: normalizeStorageRootColor(root.color),
      },
    ])
  );
};

export const saveStorageRootDisplayNames = async (
  servarrType: ServarrType,
  serviceId: number,
  inputs: StorageRootDisplayNameInput[],
  manager?: EntityManager
): Promise<void> => {
  const repository = manager
    ? manager.getRepository(StorageRoot)
    : getRepository(StorageRoot);
  const unique = new Map<number, StorageRootDisplayNameInput>();
  for (const input of inputs) {
    if (
      Number.isSafeInteger(input.sourceRootId) &&
      input.sourceRootId >= 0 &&
      typeof input.path === 'string'
    ) {
      unique.set(input.sourceRootId, input);
    }
  }

  for (const input of unique.values()) {
    let root = await repository.findOneBy({
      servarrType,
      serviceId,
      sourceRootId: input.sourceRootId,
    });
    if (!root) {
      root = new StorageRoot({
        servarrType,
        serviceId,
        sourceRootId: input.sourceRootId,
        pathSnapshot: input.path,
      });
    }
    root.displayName = normalizeStorageRootDisplayName(input.displayName);
    if (typeof input.isAnimation === 'boolean') {
      root.isAnimation = input.isAnimation;
    }
    if (input.color === null || typeof input.color === 'string') {
      root.color = normalizeStorageRootColor(input.color);
    }
    await repository.save(root);
  }
};
