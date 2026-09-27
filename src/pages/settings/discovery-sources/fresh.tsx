import SettingsFresh from '@app/components/Settings/SettingsFresh';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const FreshSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsFresh />
    </SettingsLayout>
  );
};
export default FreshSettingsPage;
