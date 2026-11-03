import PageTitle from '@app/components/Common/PageTitle';
import SettingsNavigationSelector from '@app/components/Settings/SettingsNavigationSelector';
import { useSettingsNavigation } from '@app/components/Settings/settingsNavigation';
import globalMessages from '@app/i18n/globalMessages';
import { useIntl } from 'react-intl';

type SettingsLayoutProps = {
  children: React.ReactNode;
};

const SettingsLayout = ({ children }: SettingsLayoutProps) => {
  const intl = useIntl();
  const settingsRoutes = useSettingsNavigation();

  return (
    <>
      <PageTitle title={intl.formatMessage(globalMessages.settings)} />
      <div className="mt-6">
        <SettingsNavigationSelector routes={settingsRoutes} />
      </div>
      <div className="mt-10 text-white">{children}</div>
    </>
  );
};

export default SettingsLayout;
