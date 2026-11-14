import {
  addMovieCollectionObservation,
  dropMovieCollectionObservation,
} from '@server/utils/movieCollectionObservationMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMovieCollectionObservation1790000000052 implements MigrationInterface {
  name = 'AddMovieCollectionObservation1790000000052';

  public up(runner: QueryRunner): Promise<void> {
    return addMovieCollectionObservation(runner, 'datetime');
  }

  public down(runner: QueryRunner): Promise<void> {
    return dropMovieCollectionObservation(runner);
  }
}
