import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsRemoval from '@app/components/Settings/SettingsRemoval';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const RemovalSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsRemoval />
    </SettingsLayout>
  );
};

export default RemovalSettingsPage;
