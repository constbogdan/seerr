import animeList from '@server/api/animelist';

export class JellyfinAnimeMappingCoordinator {
  private activeSync?: Promise<void>;

  constructor(private readonly sync: () => Promise<void>) {}

  public prepare(): Promise<void> {
    if (!this.activeSync) {
      this.activeSync = this.sync().finally(
        () => (this.activeSync = undefined)
      );
    }
    return this.activeSync;
  }
}

const coordinator = new JellyfinAnimeMappingCoordinator(() => animeList.sync());

export const prepareJellyfinAnimeMappings = (): Promise<void> =>
  coordinator.prepare();
