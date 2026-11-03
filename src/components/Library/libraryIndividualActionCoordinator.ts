export interface LibraryIndividualActionToken {
  key: string;
  generation: number;
}

export class LibraryIndividualActionCoordinator {
  private generation = 0;
  private readonly pending = new Map<string, number>();

  public begin(key: string): LibraryIndividualActionToken | null {
    if (this.pending.has(key)) return null;
    const generation = this.generation;
    this.pending.set(key, generation);
    return { key, generation };
  }

  public owns(token: LibraryIndividualActionToken): boolean {
    return (
      token.generation === this.generation &&
      this.pending.get(token.key) === token.generation
    );
  }

  public finish(token: LibraryIndividualActionToken): boolean {
    if (!this.owns(token)) return false;
    this.pending.delete(token.key);
    return true;
  }

  public invalidate(): void {
    this.generation += 1;
    this.pending.clear();
  }
}
