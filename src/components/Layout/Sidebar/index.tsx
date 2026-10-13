import Badge from '@app/components/Common/Badge';
import {
  getVisibleNavigationDestinations,
  isNavigationDestinationActive,
  menuMessages,
} from '@app/components/Layout/navigation';
import VersionStatus from '@app/components/Layout/VersionStatus';
import useClickOutside from '@app/hooks/useClickOutside';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import { Transition, TransitionChild } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

interface SidebarProps {
  open?: boolean;
  setClosed: () => void;
  pendingRequestsCount: number;
  openIssuesCount: number;
  revalidateIssueCount: () => void;
  revalidateRequestsCount: () => void;
}

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
