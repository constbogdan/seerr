import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsStorage from '@app/components/Settings/SettingsStorage';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const StorageSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsStorage />
    </SettingsLayout>
  );
};

export default StorageSettingsPage;
