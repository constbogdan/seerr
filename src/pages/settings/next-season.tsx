import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsNextSeason from '@app/components/Settings/SettingsNextSeason';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const NextSeasonSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);

  return (
    <SettingsLayout>
      <SettingsNextSeason />
    </SettingsLayout>
  );
};

export default NextSeasonSettingsPage;
