import { TableColumn, type QueryRunner } from 'typeorm';

export interface HydrationRunLeaseMigrationOptions {
  timestampType: string;
}

export const addHydrationRunLeaseMetadata = async (
  queryRunner: QueryRunner,
  options: HydrationRunLeaseMigrationOptions
) => {
  await queryRunner.addColumns('hydration_run', [
    new TableColumn({
      name: 'heartbeatAt',
      type: options.timestampType,
      isNullable: true,
    }),
    new TableColumn({
      name: 'leaseExpiresAt',
      type: options.timestampType,
      isNullable: true,
    }),
  ]);
  await queryRunner.query(
    `CREATE INDEX "IDX_hydration_run_status_lease" ON "hydration_run" ("status", "leaseExpiresAt")`
  );
};

export const dropHydrationRunLeaseMetadata = async (
  queryRunner: QueryRunner
) => {
  await queryRunner.query('DROP INDEX "IDX_hydration_run_status_lease"');
  await queryRunner.dropColumns('hydration_run', [
    'leaseExpiresAt',
    'heartbeatAt',
  ]);
};
