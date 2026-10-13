import type { ButtonType } from '@app/components/Common/Button';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useClickOutside from '@app/hooks/useClickOutside';
import { useLockBodyScroll } from '@app/hooks/useLockBodyScroll';
import globalMessages from '@app/i18n/globalMessages';
import { Transition, TransitionChild } from '@headlessui/react';
import type { MouseEvent } from 'react';
import React, { Fragment, useEffect, useId, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useIntl } from 'react-intl';

interface ModalProps {
  title?: string;
  subTitle?: string;
  onCancel?: (e?: MouseEvent<HTMLElement>) => void;
  onOk?: (e?: MouseEvent<HTMLButtonElement>) => void;
  onSecondary?: (e?: MouseEvent<HTMLButtonElement>) => void;
  onTertiary?: (e?: MouseEvent<HTMLButtonElement>) => void;
  cancelText?: string;
  okText?: string;
  secondaryText?: string;
  tertiaryText?: string;
  okDisabled?: boolean;
  cancelButtonType?: ButtonType;
  okButtonType?: ButtonType;
  secondaryButtonType?: ButtonType;
  secondaryDisabled?: boolean;
  tertiaryDisabled?: boolean;
  tertiaryButtonType?: ButtonType;
  okButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  cancelButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  secondaryButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  tertiaryButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  disableScrollLock?: boolean;
  backgroundClickable?: boolean;
  loading?: boolean;
  backdrop?: string;
  children?: React.ReactNode;
  dialogClass?: string;
}

const modalStack: symbol[] = [];
const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const visibleFocusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => {
      const style = window.getComputedStyle(element);
      return (
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.closest('[hidden]') &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    }
  );

const Modal = React.forwardRef<HTMLDivElement, ModalProps>(
  (
    {
      title,
      subTitle,
      onCancel,
      onOk,
      cancelText,
      okText,
      okDisabled = false,
      cancelButtonType = 'default',
      okButtonType = 'primary',
      children,
      disableScrollLock,
      backgroundClickable = true,
      secondaryButtonType = 'default',
      secondaryDisabled = false,
      onSecondary,
      secondaryText,
      tertiaryButtonType = 'default',
      tertiaryDisabled = false,
      tertiaryText,
      loading = false,
      onTertiary,
      backdrop,
      dialogClass,
      okButtonProps,
      cancelButtonProps,
      secondaryButtonProps,
      tertiaryButtonProps,
    },
    parentRef
  ) => {
    const intl = useIntl();
    const modalRef = useRef<HTMLDivElement>(null);
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const originatingElementRef = useRef<HTMLElement | null>(null);
    const modalTokenRef = useRef(Symbol('modal'));
    const onCancelRef = useRef(onCancel);
    const cancelDisabledRef = useRef(cancelButtonProps?.disabled ?? false);
    const generatedId = useId().replaceAll(':', '');
    const titleId = `modal-title-${generatedId}`;
    const descriptionId = `modal-description-${generatedId}`;
    const focusConfiguration = [
      Boolean(onCancel && !cancelButtonProps?.disabled),
      Boolean(onOk && !okDisabled && !okButtonProps?.disabled),
      Boolean(onSecondary && !secondaryDisabled),
      Boolean(onTertiary && !tertiaryDisabled),
    ].join(':');
    onCancelRef.current = onCancel;
    cancelDisabledRef.current = cancelButtonProps?.disabled ?? false;
    const backgroundClickableRef = useRef(backgroundClickable); // This ref is used to detect state change inside the useClickOutside hook
    useEffect(() => {
      backgroundClickableRef.current = backgroundClickable;
    }, [backgroundClickable]);
    useClickOutside(modalRef, () => {
      if (onCancel && backgroundClickableRef.current) {
        onCancel();
      }
    });
    useLockBodyScroll(true, disableScrollLock);

    useEffect(() => {
      const token = modalTokenRef.current;
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      originatingElementRef.current = activeElement;
      modalStack.push(token);

      const handleKeyDown = (event: KeyboardEvent) => {
        if (modalStack.at(-1) !== token || event.defaultPrevented) return;

        if (event.key === 'Escape') {
          if (onCancelRef.current && !cancelDisabledRef.current) {
            event.preventDefault();
            event.stopPropagation();
            onCancelRef.current();
          }
          return;
        }

        if (event.key !== 'Tab' || !modalRef.current) return;
        const focusable = visibleFocusableElements(modalRef.current);
        if (focusable.length === 0) {
          event.preventDefault();
          modalRef.current.focus();
          return;
        }

        const first = focusable[0];
        const last = focusable.at(-1) as HTMLElement;
        if (!modalRef.current.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      document.addEventListener('keydown', handleKeyDown, true);
      return () => {
        document.removeEventListener('keydown', handleKeyDown, true);
        const stackIndex = modalStack.lastIndexOf(token);
        if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
        const originatingElement = originatingElementRef.current;
        if (originatingElement?.isConnected) {
          originatingElement.focus({ preventScroll: true });
        }
      };
    }, []);

    useEffect(() => {
      if (loading) return;
      const frame = window.requestAnimationFrame(() => {
        if (modalStack.at(-1) !== modalTokenRef.current || !modalRef.current)
          return;
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLElement &&
          modalRef.current.contains(activeElement) &&
          !(
            activeElement instanceof HTMLButtonElement && activeElement.disabled
          )
        ) {
          return;
        }
        const preferred =
          cancelButtonRef.current && !cancelButtonRef.current.disabled
            ? cancelButtonRef.current
            : visibleFocusableElements(modalRef.current)[0];
        (preferred ?? modalRef.current).focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }, [focusConfiguration, loading]);

    return ReactDOM.createPortal(
      <TransitionChild
        as="div"
        className="fixed bottom-0 left-0 right-0 top-0 z-50 flex h-full w-full items-center justify-center bg-gray-800/70"
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        ref={parentRef}
      >
        <Transition
          appear
          as={Fragment}
          enter="transition duration-300"
          enterFrom="opacity-0 scale-75"
          enterTo="opacity-100 scale-100"
          leave="transition-opacity duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          show={loading}
        >
          <div style={{ position: 'absolute' }}>
            <LoadingSpinner />
          </div>
        </Transition>
        <Transition
          className={`hide-scrollbar relative inline-block w-full overflow-auto bg-gray-800 px-4 pb-4 pt-4 text-left align-bottom shadow-xl ring-1 ring-gray-700 transition-all sm:my-8 sm:max-w-3xl sm:rounded-lg sm:align-middle ${dialogClass}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title || subTitle ? titleId : undefined}
          aria-describedby={title && subTitle ? descriptionId : undefined}
          aria-busy={loading}
          tabIndex={-1}
          style={{
            maxHeight: 'calc(100% - env(safe-area-inset-top) * 2)',
          }}
          appear
          as="div"
          enter="transition duration-300"
          enterFrom="opacity-0 scale-75"
          enterTo="opacity-100 scale-100"
          leave="transition-opacity duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          show={!loading}
          ref={modalRef}
        >
          {backdrop && (
            <div className="absolute left-0 right-0 top-0 z-0 h-64 max-h-full w-full">
              <CachedImage
                type="tmdb"
                alt=""
                src={backdrop}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                fill
                priority
              />
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    'linear-gradient(180deg, rgba(31, 41, 55, 0.75) 0%, rgba(31, 41, 55, 1) 100%)',
                }}
              />
            </div>
          )}
          <div className="relative -mx-4 overflow-x-hidden px-4 pt-0.5 sm:flex sm:items-center">
            <div
              className={`mt-3 truncate text-center text-white sm:mt-0 sm:text-left`}
            >
              {(title || subTitle) && (
                <div className="flex flex-col space-y-1">
                  {title && (
                    <span
                      className="text-overseerr truncate pb-0.5 text-2xl font-bold leading-6"
                      id={titleId}
                      data-testid="modal-title"
                    >
                      {title}
                    </span>
                  )}
                  {subTitle && (
                    <span
                      className="truncate text-lg font-semibold leading-6 text-gray-200"
                      id={title ? descriptionId : titleId}
                      data-testid="modal-subtitle"
                    >
                      {subTitle}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {children && (
            <div
              className={`relative mt-4 text-sm leading-5 text-gray-300 ${
                !(onCancel || onOk || onSecondary || onTertiary) ? 'mb-3' : ''
              }`}
            >
              {children}
            </div>
          )}
          {(onCancel || onOk || onSecondary || onTertiary) && (
            <div className="relative mt-5 flex flex-row-reverse justify-center sm:mt-4 sm:justify-start">
              {typeof onOk === 'function' && (
                <Button
                  buttonType={okButtonType}
                  onClick={onOk}
                  className="ml-3"
                  disabled={okDisabled}
                  data-testid="modal-ok-button"
                  {...okButtonProps}
                >
                  {okText ? okText : 'Ok'}
                </Button>
              )}
              {typeof onSecondary === 'function' && secondaryText && (
                <Button
                  buttonType={secondaryButtonType}
                  onClick={onSecondary}
                  className="ml-3"
                  disabled={secondaryDisabled}
                  data-testid="modal-secondary-button"
                  {...secondaryButtonProps}
                >
                  {secondaryText}
                </Button>
              )}
              {typeof onTertiary === 'function' && tertiaryText && (
                <Button
                  buttonType={tertiaryButtonType}
                  onClick={onTertiary}
                  className="ml-3"
                  disabled={tertiaryDisabled}
                  {...tertiaryButtonProps}
                >
                  {tertiaryText}
                </Button>
              )}
              {typeof onCancel === 'function' && (
                <Button
                  ref={cancelButtonRef}
                  buttonType={cancelButtonType}
                  onClick={onCancel}
                  className="ml-3 sm:ml-0"
                  data-testid="modal-cancel-button"
                  {...cancelButtonProps}
                >
                  {cancelText
                    ? cancelText
                    : intl.formatMessage(globalMessages.cancel)}
                </Button>
              )}
            </div>
          )}
        </Transition>
      </TransitionChild>,
      document.body
    );
  }
);

Modal.displayName = 'Modal';

export default Modal;
