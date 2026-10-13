import dataSource from '@server/datasource';
import { LibraryHydrationEpoch } from '@server/entity/LibraryHydration';
import type { DataSource, EntityManager } from 'typeorm';

export const CURRENT_LIBRARY_GENERATION_SOURCE = 'library';
export const CURRENT_LIBRARY_GENERATION_SCOPE = 'current-membership';

export class LibraryHydrationEpochChangedError extends Error {
  constructor(
    public readonly sourceSystem: string,
    public readonly sourceScope: string
  ) {
    super('The Library source changed after its provider snapshot was read');
  }
}

export class LibraryHydrationEpochService {
  constructor(private readonly connection: DataSource = dataSource) {}

  private async lock(
    manager: EntityManager,
    sourceSystem: string,
    sourceScope: string
  ): Promise<LibraryHydrationEpoch> {
    const repository = manager.getRepository(LibraryHydrationEpoch);
    await repository
      .createQueryBuilder()
      .insert()
      .values({ sourceSystem, sourceScope, epoch: 0 })
      .orIgnore()
      .updateEntity(false)
      .execute();
    if (this.connection.options.type !== 'postgres') {
      await repository
        .createQueryBuilder()
        .update(LibraryHydrationEpoch)
        .set({ epoch: () => '"epoch"' })
        .where('sourceSystem = :sourceSystem', { sourceSystem })
        .andWhere('sourceScope = :sourceScope', { sourceScope })
        .execute();
    }
    const query = repository
      .createQueryBuilder('epoch')
      .where('epoch.sourceSystem = :sourceSystem', { sourceSystem })
      .andWhere('epoch.sourceScope = :sourceScope', { sourceScope });
    if (this.connection.options.type === 'postgres') {
      query.setLock('pessimistic_write');
    }
    return query.getOneOrFail();
  }

  public async capture(
    sourceSystem: string,
    sourceScope: string,
    manager?: EntityManager
  ): Promise<number> {
    if (manager) {
      const epoch = await this.lock(manager, sourceSystem, sourceScope);
      return epoch.epoch;
    }
    return this.connection.transaction('SERIALIZABLE', async (manager) => {
      const epoch = await this.lock(manager, sourceSystem, sourceScope);
      return epoch.epoch;
    });
  }

  public async assert(
    manager: EntityManager,
    sourceSystem: string,
    sourceScope: string,
    expectedEpoch: number
  ): Promise<void> {
    const epoch = await this.lock(manager, sourceSystem, sourceScope);
    if (epoch.epoch !== expectedEpoch) {
      throw new LibraryHydrationEpochChangedError(sourceSystem, sourceScope);
    }
  }

  public async advance(
    manager: EntityManager,
    sourceSystem: string,
    sourceScope: string
  ): Promise<number> {
    const epoch = await this.lock(manager, sourceSystem, sourceScope);
    epoch.epoch += 1;
    await manager.getRepository(LibraryHydrationEpoch).save(epoch);
    return epoch.epoch;
  }
}

const libraryHydrationEpoch = new LibraryHydrationEpochService();

export class CurrentLibraryGenerationService {
  constructor(
    private readonly epochs: LibraryHydrationEpochService = libraryHydrationEpoch
  ) {}

  public capture(manager?: EntityManager): Promise<number> {
    return this.epochs.capture(
      CURRENT_LIBRARY_GENERATION_SOURCE,
      CURRENT_LIBRARY_GENERATION_SCOPE,
      manager
    );
  }

  public assert(manager: EntityManager, expectedGeneration: number) {
    return this.epochs.assert(
      manager,
      CURRENT_LIBRARY_GENERATION_SOURCE,
      CURRENT_LIBRARY_GENERATION_SCOPE,
      expectedGeneration
    );
  }

  public advance(manager: EntityManager): Promise<number> {
    return this.epochs.advance(
      manager,
      CURRENT_LIBRARY_GENERATION_SOURCE,
      CURRENT_LIBRARY_GENERATION_SCOPE
    );
  }
}

export const currentLibraryGeneration = new CurrentLibraryGenerationService();
export default libraryHydrationEpoch;
