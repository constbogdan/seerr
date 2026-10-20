import { useUser } from '@app/hooks/useUser';
import { hasPermission } from '@server/lib/permissions';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import {
  settingsNavigationMessages,
  type SettingsNavigationRoute,
} from './settingsNavigation';

const SettingsNavigationSelector = ({
  routes,
}: {
  routes: SettingsNavigationRoute[];
}) => {
  const router = useRouter();
  const intl = useIntl();
  const { user } = useUser();
  const visibleRoutes = routes.filter(
    (route) =>
      !route.hidden &&
      (route.requiredPermission
        ? hasPermission(
            route.requiredPermission,
            user?.permissions ?? 0,
            route.permissionType
          )
        : true)
  );
  const activeRoute = visibleRoutes.find((route) =>
    route.regex.test(router.pathname)
  );
  const label = intl.formatMessage(
    settingsNavigationMessages.selectSettingsPage
  );

  return (
    <div className="lg:hidden">
      <label htmlFor="settings-page-selector" className="sr-only">
        {label}
      </label>
      <select
        id="settings-page-selector"
        value={activeRoute?.route ?? '/settings/main'}
        aria-label={label}
        onChange={(event) => router.push(event.target.value)}
      >
        {visibleRoutes.map((route) => (
          <option key={route.id} value={route.route}>
            {route.text}
          </option>
        ))}
      </select>
    </div>
  );
};

export default SettingsNavigationSelector;
