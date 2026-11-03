import Badge from '@app/components/Common/Badge';
import {
  getBottomNavigationDestinations,
  getVisibleNavigationDestinations,
  isNavigationDestinationActive,
  menuMessages,
} from '@app/components/Layout/navigation';
import useClickOutside from '@app/hooks/useClickOutside';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import { Transition } from '@headlessui/react';
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline';
import { XMarkIcon } from '@heroicons/react/24/solid';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

interface MobileMenuProps {
  pendingRequestsCount: number;
  openIssuesCount: number;
  revalidateIssueCount: () => void;
  revalidateRequestsCount: () => void;
}

const MobileMenu = ({
  pendingRequestsCount,
  openIssuesCount,
  revalidateIssueCount,
  revalidateRequestsCount,
}: MobileMenuProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const firstDrawerLinkRef = useRef<HTMLAnchorElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const intl = useIntl();
  const [isOpen, setIsOpen] = useState(false);
  const { hasPermission, loading: userLoading, user } = useUser();
  const { currentSettings } = useSettings();
  const router = useRouter();
  useClickOutside(ref, () => {
    setTimeout(() => {
      if (isOpen) {
        setIsOpen(false);
      }
    }, 150);
  });

  const toggle = () => setIsOpen(!isOpen);

  const filteredLinks = getVisibleNavigationDestinations({
    freshEnabled: currentSettings.freshEnabled,
    hasPermission,
  });
  const permissionsResolved = !userLoading && Boolean(user);
  const primaryLinks = permissionsResolved
    ? getBottomNavigationDestinations(
        filteredLinks,
        hasPermission(Permission.ADMIN)
      )
    : [];

  useEffect(() => {
    let animationFrame: number | undefined;

    if (isOpen) {
      animationFrame = window.requestAnimationFrame(() =>
        firstDrawerLinkRef.current?.focus()
      );
    } else if (wasOpenRef.current) {
      moreButtonRef.current?.focus();
    }

    wasOpenRef.current = isOpen;

    return () => {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [isOpen]);

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
    <div className="fixed bottom-0 left-0 right-0 z-50">
      <Transition
        show={isOpen}
        as="div"
        ref={ref}
        id="mobile-navigation-drawer"
        role="navigation"
        aria-label={intl.formatMessage(menuMessages.navigation)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setIsOpen(false);
          }
        }}
        enter="transition duration-500"
        enterFrom="opacity-0 translate-y-0"
        enterTo="opacity-100 -translate-y-full"
        leave="transition duration-500"
        leaveFrom="opacity-100 -translate-y-full"
        leaveTo="opacity-0 translate-y-0"
        className="absolute left-0 right-0 top-0 flex max-h-[calc(100dvh-4rem)] w-full -translate-y-full flex-col space-y-6 overflow-y-auto overscroll-contain border-t border-gray-600 bg-gray-900/90 px-6 py-6 font-semibold text-gray-100 backdrop-blur"
      >
        {filteredLinks.map((link, index) => {
          const isActive = isNavigationDestinationActive(link, router.pathname);
          const Icon = isActive ? link.selectedIcon : link.icon;
          return (
            <Link
              key={`mobile-menu-link-${link.href}`}
              ref={index === 0 ? firstDrawerLinkRef : undefined}
              href={link.href}
              className={`flex items-center ${
                isActive ? 'text-indigo-500' : ''
              }`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setIsOpen(false);
                }
              }}
              onClick={() => setIsOpen(false)}
              data-testid={`mobile-menu-${link.id}`}
            >
              <Icon className="h-5 w-5" />
              <span className="ml-2">
                {intl.formatMessage(menuMessages[link.messagesKey])}
              </span>
              {link.href === '/requests' &&
                pendingRequestsCount > 0 &&
                hasPermission(Permission.MANAGE_REQUESTS) && (
                  <div className="ml-auto flex">
                    <Badge className="rounded-md border-indigo-500 bg-gradient-to-br from-indigo-600 to-purple-600">
                      {pendingRequestsCount}
                    </Badge>
                  </div>
                )}
              {link.href === '/issues' &&
                openIssuesCount > 0 &&
                hasPermission(Permission.MANAGE_ISSUES) && (
                  <div className="ml-auto flex">
                    <Badge className="rounded-md border-indigo-500 bg-gradient-to-br from-indigo-600 to-purple-600">
                      {openIssuesCount}
                    </Badge>
                  </div>
                )}
            </Link>
          );
        })}
      </Transition>
      <div className="padding-bottom-safe border-t border-gray-600 bg-gray-800/90 backdrop-blur">
        <div className="flex h-full items-center justify-between px-6 py-1.5 text-gray-100">
          {primaryLinks.map((link) => {
            const isActive =
              isNavigationDestinationActive(link, router.pathname) && !isOpen;
            const Icon = isActive ? link.selectedIcon : link.icon;
            const label = intl.formatMessage(menuMessages[link.messagesKey]);
            return (
              <Link
                key={`mobile-menu-link-${link.href}`}
                href={link.href}
                aria-label={label}
                className={`relative flex h-11 w-11 items-center justify-center ${
                  isActive ? 'text-indigo-500' : ''
                }`}
              >
                <span className="relative flex h-6 w-6">
                  <Icon className="h-6 w-6" />
                  {link.href === '/requests' &&
                    pendingRequestsCount > 0 &&
                    hasPermission(Permission.MANAGE_REQUESTS) && (
                      <div className="absolute bottom-3 left-3">
                        <Badge
                          className={`bg-gradient-to-br ${
                            isNavigationDestinationActive(link, router.pathname)
                              ? 'border-indigo-600 from-indigo-700 to-purple-700'
                              : 'border-indigo-500 from-indigo-600 to-purple-600'
                          } flex ${
                            pendingRequestsCount > 99 ? 'w-6' : 'w-4'
                          } h-4 items-center justify-center !px-[5px] !py-[7px] text-[8px]`}
                        >
                          {pendingRequestsCount > 99
                            ? '99+'
                            : pendingRequestsCount}
                        </Badge>
                      </div>
                    )}
                </span>
              </Link>
            );
          })}
          {permissionsResolved &&
            filteredLinks.length > primaryLinks.length && (
              <button
                ref={moreButtonRef}
                className={`flex h-11 w-11 items-center justify-center ${
                  isOpen ? 'text-indigo-500' : ''
                }`}
                aria-expanded={isOpen}
                aria-controls="mobile-navigation-drawer"
                aria-label={intl.formatMessage(
                  isOpen ? menuMessages.closeMore : menuMessages.more
                )}
                onClick={() => toggle()}
              >
                {isOpen ? (
                  <XMarkIcon className="h-6 w-6" />
                ) : (
                  <EllipsisHorizontalIcon className="h-6 w-6" />
                )}
              </button>
            )}
        </div>
      </div>
    </div>
  );
};

export default MobileMenu;
