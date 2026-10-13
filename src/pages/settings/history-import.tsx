import SettingsHistoryImport from '@app/components/Settings/SettingsHistoryImport';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@server/lib/permissions';
import type { NextPage } from 'next';

const SettingsHistoryImportPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsHistoryImport />
    </SettingsLayout>
  );
};

export default SettingsHistoryImportPage;
