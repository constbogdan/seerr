import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsWatchlistRoulette from '@app/components/Settings/SettingsWatchlistRoulette';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const WatchlistRouletteSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsWatchlistRoulette />
    </SettingsLayout>
  );
};

export default WatchlistRouletteSettingsPage;
