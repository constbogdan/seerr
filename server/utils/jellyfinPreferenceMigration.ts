import { TableColumn, type QueryRunner } from 'typeorm';

export const jellyfinPreferenceColumns = (timestampType: string) => [
  new TableColumn({
    name: 'jellyfinPlayStateTracked',
    type: 'boolean',
    default: timestampType === 'datetime' ? '1' : 'true',
  }),
  new TableColumn({ name: 'jellyfinLikes', type: 'boolean', isNullable: true }),
  new TableColumn({
    name: 'jellyfinPreferenceObservedAt',
    type: timestampType,
    isNullable: true,
  }),
  new TableColumn({
    name: 'jellyfinPreferenceSourceScope',
    type: 'varchar',
    length: '128',
    isNullable: true,
  }),
  new TableColumn({
    name: 'jellyfinPreferenceUserId',
    type: 'varchar',
    length: '32',
    isNullable: true,
  }),
  new TableColumn({
    name: 'jellyfinPreferenceItemIds',
    type: 'text',
    isNullable: true,
  }),
];

export const addJellyfinPreference = async (
  runner: QueryRunner,
  timestampType: string
): Promise<void> => {
  await runner.addColumns(
    'user_media_state',
    jellyfinPreferenceColumns(timestampType)
  );
};

export const dropJellyfinPreference = async (
  runner: QueryRunner
): Promise<void> => {
  await runner.dropColumns(
    'user_media_state',
    jellyfinPreferenceColumns('datetime').map(({ name }) => name)
  );
};
