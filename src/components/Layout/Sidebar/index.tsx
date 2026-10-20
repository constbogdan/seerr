import Badge from '@app/components/Common/Badge';
import {
  getVisibleNavigationDestinations,
  isNavigationDestinationActive,
  menuMessages,
  type NavigationDestination,
} from '@app/components/Layout/navigation';
import VersionStatus from '@app/components/Layout/VersionStatus';
import {
  useSettingsNavigation,
  type SettingsNavigationRoute,
} from '@app/components/Settings/settingsNavigation';
import {
  isSettingsPath,
  synchronizeSettingsMenuExpansion,
} from '@app/components/Settings/settingsNavigationState';
import useClickOutside from '@app/hooks/useClickOutside';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import { Transition, TransitionChild } from '@headlessui/react';
import { ChevronDownIcon, XMarkIcon } from '@heroicons/react/24/outline';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

interface SidebarProps {
  open?: boolean;
  setClosed: () => void;
  pendingRequestsCount: number;
  openIssuesCount: number;
  revalidateIssueCount: () => void;
  revalidateRequestsCount: () => void;
}

interface SettingsNavigationGroupProps {
  destination: NavigationDestination;
  routes: SettingsNavigationRoute[];
  variant: 'desktop' | 'tablet';
  closeDrawer?: () => void;
}

const SettingsNavigationGroup = ({
  destination,
  routes,
  variant,
  closeDrawer,
}: SettingsNavigationGroupProps) => {
  const router = useRouter();
  const intl = useIntl();
  const settingsPath = isSettingsPath(router.pathname);
  const [expanded, setExpanded] = useState(settingsPath);
  const previousSettingsPathRef = useRef(settingsPath);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLUListElement>(null);
  const activeItemRef = useRef<HTMLAnchorElement>(null);
  const submenuId = `settings-navigation-submenu-${variant}`;
  const SidebarIcon = destination.sidebarIcon ?? destination.icon;

  useEffect(() => {
    if (
      !settingsPath &&
      previousSettingsPathRef.current &&
      submenuRef.current?.contains(document.activeElement)
    ) {
      buttonRef.current?.focus();
    }
    setExpanded((current) =>
      synchronizeSettingsMenuExpansion({
        expanded: current,
        wasSettingsPath: previousSettingsPathRef.current,
        settingsPath,
      })
    );
    previousSettingsPathRef.current = settingsPath;
  }, [settingsPath]);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      activeItemRef.current?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [expanded, router.pathname]);

  const toggleExpanded = () => {
    if (
      expanded &&
      submenuRef.current?.contains(document.activeElement) &&
      document.activeElement !== buttonRef.current
    ) {
      buttonRef.current?.focus();
    }
    setExpanded((current) => !current);
  };

  return (
    <div data-testid={`sidebar-settings-group-${variant}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={submenuId}
        onClick={toggleExpanded}
        className={`group flex w-full items-center rounded-md px-2 py-2 font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
          variant === 'desktop' ? 'text-lg' : 'text-base'
        } ${
          settingsPath
            ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
            : 'hover:bg-gray-700 focus:bg-gray-700'
        }`}
        data-testid={`sidebar-menu-settings${
          variant === 'tablet' ? '-mobile' : ''
        }`}
      >
        <SidebarIcon className="mr-3 h-6 w-6 flex-shrink-0" />
        <span className="min-w-0 flex-1 text-left">
          {intl.formatMessage(menuMessages.settings)}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={`ml-2 h-5 w-5 flex-shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
        <ul
          ref={submenuRef}
          id={submenuId}
          className="mt-1 space-y-1 pl-9"
          data-testid={`settings-submenu-${variant}`}
        >
          {routes.map((route) => {
            const active = route.regex.test(router.pathname);
            return (
              <li key={route.id}>
                <Link
                  ref={active ? activeItemRef : undefined}
                  href={route.route}
                  aria-current={active ? 'page' : undefined}
                  onClick={closeDrawer}
                  className={`block rounded-md px-3 py-2 text-sm font-medium leading-5 transition duration-150 ease-in-out focus:outline-none ${
                    active
                      ? 'bg-gray-700 text-indigo-300'
                      : 'text-gray-300 hover:bg-gray-700 hover:text-white focus:bg-gray-700 focus:text-white'
                  }`}
                  data-testid={`settings-submenu-${route.id}-${variant}`}
                >
                  {route.text}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const Sidebar = ({
  open,
  setClosed,
  pendingRequestsCount,
  openIssuesCount,
  revalidateIssueCount,
  revalidateRequestsCount,
}: SidebarProps) => {
  const navRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const { hasPermission } = useUser();
  const settingsRoutes = useSettingsNavigation();
  const visibleDestinations = getVisibleNavigationDestinations({
    freshEnabled: currentSettings.freshEnabled,
    hasPermission,
  });
  useClickOutside(navRef, () => setClosed());

  useEffect(() => {
    let animationFrame: number | undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setClosed();
      }
    };

    if (open) {
      animationFrame = window.requestAnimationFrame(() =>
        closeButtonRef.current?.focus()
      );
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [open, setClosed]);

  useEffect(() => {
    if (openIssuesCount) {
      revalidateIssueCount();
    }

    if (pendingRequestsCount) {
      revalidateRequestsCount();
    }
  }, [
    revalidateIssueCount,
    revalidateRequestsCount,
    pendingRequestsCount,
    openIssuesCount,
  ]);

  return (
    <>
      <div className="lg:hidden">
        <Transition as={Fragment} show={open}>
          <div className="fixed inset-0 z-40 flex">
            <TransitionChild
              as="div"
              enter="transition-opacity ease-linear duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition-opacity ease-linear duration-300"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="fixed inset-0">
                <div className="absolute inset-0 bg-gray-900 opacity-90" />
              </div>
            </TransitionChild>
            <TransitionChild
              as="div"
              enter="transition-transform ease-in-out duration-300"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transition-transform ease-in-out duration-300"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <>
                <div
                  ref={navRef}
                  id="tablet-navigation-drawer"
                  role="navigation"
                  aria-label={intl.formatMessage(menuMessages.navigation)}
                  className="sidebar relative flex h-full w-full max-w-xs flex-1 flex-col bg-gray-800"
                >
                  <div className="sidebar-close-button absolute right-0 -mr-14 p-1">
                    <button
                      ref={closeButtonRef}
                      className="flex h-12 w-12 items-center justify-center rounded-full focus:bg-gray-600 focus:outline-none"
                      aria-label={intl.formatMessage(menuMessages.closeMore)}
                      onClick={() => setClosed()}
                    >
                      <XMarkIcon className="h-6 w-6 text-white" />
                    </button>
                  </div>
                  <div className="flex flex-1 flex-col overflow-y-auto pb-8 pt-4 sm:pb-4">
                    <div className="flex flex-shrink-0 items-center px-2">
                      <span className="w-full px-4 text-xl text-gray-50">
                        <Link href="/" className="relative block h-24 w-64">
                          <Image src="/logo_full.svg" alt="Logo" fill />
                        </Link>
                      </span>
                    </div>
                    <nav className="mt-10 flex-1 space-y-4 px-4">
                      {visibleDestinations.map((sidebarLink) => {
                        const SidebarIcon =
                          sidebarLink.sidebarIcon ?? sidebarLink.icon;
                        if (sidebarLink.id === 'settings') {
                          return (
                            <SettingsNavigationGroup
                              key="tablet-settings"
                              destination={sidebarLink}
                              routes={settingsRoutes}
                              variant="tablet"
                              closeDrawer={setClosed}
                            />
                          );
                        }
                        return (
                          <Link
                            key={`mobile-${sidebarLink.messagesKey}`}
                            href={sidebarLink.href}
                            onClick={() => setClosed()}
                            className={`flex items-center rounded-md px-2 py-2 text-base font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
                              isNavigationDestinationActive(
                                sidebarLink,
                                router.pathname
                              )
                                ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
                                : 'hover:bg-gray-700 focus:bg-gray-700'
                            } `}
                            data-testid={`sidebar-menu-${sidebarLink.id}-mobile`}
                          >
                            <SidebarIcon className="mr-3 h-6 w-6" />
                            {intl.formatMessage(
                              menuMessages[sidebarLink.messagesKey]
                            )}
                          </Link>
                        );
                      })}
                    </nav>
                    {hasPermission(Permission.ADMIN) && (
                      <div className="px-2">
                        <VersionStatus onClick={() => setClosed()} />
                      </div>
                    )}
                  </div>
                </div>
                <div className="w-14 flex-shrink-0">
                  {/* <!-- Force sidebar to shrink to fit close icon --> */}
                </div>
              </>
            </TransitionChild>
          </div>
        </Transition>
      </div>

      <div className="fixed bottom-0 left-0 top-0 z-30 hidden lg:flex lg:flex-shrink-0">
        <div className="sidebar flex w-64 flex-col">
          <div className="flex h-0 flex-1 flex-col">
            <div className="flex flex-1 flex-col overflow-y-auto pb-4">
              <div className="flex flex-shrink-0 items-center">
                <span className="w-full px-4 py-2 text-2xl text-gray-50">
                  <Link href="/" className="relative block h-24">
                    <Image
                      src="/logo_full.svg"
                      alt="Logo"
                      fill
                      loading="eager"
                    />
                  </Link>
                </span>
              </div>
              <nav className="mt-8 flex-1 space-y-4 px-4">
                {visibleDestinations.map((sidebarLink) => {
                  const SidebarIcon =
                    sidebarLink.sidebarIcon ?? sidebarLink.icon;
                  if (sidebarLink.id === 'settings') {
                    return (
                      <SettingsNavigationGroup
                        key="desktop-settings"
                        destination={sidebarLink}
                        routes={settingsRoutes}
                        variant="desktop"
                      />
                    );
                  }
                  return (
                    <Link
                      key={`desktop-${sidebarLink.messagesKey}`}
                      href={sidebarLink.href}
                      className={`group flex items-center rounded-md px-2 py-2 text-lg font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
                        isNavigationDestinationActive(
                          sidebarLink,
                          router.pathname
                        )
                          ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
                          : 'hover:bg-gray-700 focus:bg-gray-700'
                      } `}
                      data-testid={`sidebar-menu-${sidebarLink.id}`}
                    >
                      <SidebarIcon className="mr-3 h-6 w-6" />
                      {intl.formatMessage(
                        menuMessages[sidebarLink.messagesKey]
                      )}
                      {sidebarLink.messagesKey === 'requests' &&
                        pendingRequestsCount > 0 &&
                        hasPermission(Permission.MANAGE_REQUESTS) && (
                          <div className="ml-auto flex">
                            <Badge
                              className={`rounded-md bg-gradient-to-br ${
                                isNavigationDestinationActive(
                                  sidebarLink,
                                  router.pathname
                                )
                                  ? 'border-indigo-600 from-indigo-700 to-purple-700'
                                  : 'border-indigo-500 from-indigo-600 to-purple-600'
                              }`}
                            >
                              {pendingRequestsCount}
                            </Badge>
                          </div>
                        )}
                      {sidebarLink.messagesKey === 'issues' &&
                        openIssuesCount > 0 &&
                        hasPermission(Permission.MANAGE_ISSUES) && (
                          <div className="ml-auto flex">
                            <Badge
                              className={`rounded-md bg-gradient-to-br ${
                                isNavigationDestinationActive(
                                  sidebarLink,
                                  router.pathname
                                )
                                  ? 'border-indigo-600 from-indigo-700 to-purple-700'
                                  : 'border-indigo-500 from-indigo-600 to-purple-600'
                              }`}
                            >
                              {openIssuesCount}
                            </Badge>
                          </div>
                        )}
                    </Link>
                  );
                })}
              </nav>
              {hasPermission(Permission.ADMIN) && (
                <div className="px-2">
                  <VersionStatus />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default Sidebar;
