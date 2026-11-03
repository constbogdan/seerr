import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { LibraryIndividualActionCoordinator } from './libraryIndividualActionCoordinator';

const messages = defineMessages('components.Library.IndividualActions', {
  actionFailed: 'Unable to {action}.',
  refreshFailed:
    'The action completed, but Library could not refresh. Reload to verify the current state.',
});

interface RunLibraryIndividualActionOptions {
  key: string;
  actionLabel: string;
  action: () => Promise<unknown>;
  refresh?: () => Promise<unknown>;
  onCompleted?: () => void;
}

const getServerErrorMessage = (error: unknown): string | undefined => {
  if (!axios.isAxiosError(error)) return undefined;
  const response = error.response?.data;
  if (!response || typeof response !== 'object') return undefined;
  const message = (response as { message?: unknown; error?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message;
  const fallback = (response as { error?: unknown }).error;
  return typeof fallback === 'string' && fallback.trim() ? fallback : undefined;
};

const useLibraryIndividualActions = (scope: string) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const coordinatorRef = useRef(new LibraryIndividualActionCoordinator());
  const currentScopeRef = useRef(scope);
  const mountedRef = useRef(true);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  if (currentScopeRef.current !== scope) {
    currentScopeRef.current = scope;
    coordinatorRef.current.invalidate();
  }

  useEffect(() => {
    setPendingKeys(new Set());
  }, [scope]);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      coordinator.invalidate();
    };
  }, []);

  const run = useCallback(
    async ({
      key,
      actionLabel,
      action,
      refresh,
      onCompleted,
    }: RunLibraryIndividualActionOptions): Promise<boolean> => {
      const operationScope = currentScopeRef.current;
      const token = coordinatorRef.current.begin(key);
      if (!token) return false;

      setPendingKeys((current) => new Set(current).add(key));
      let actionCompleted = false;
      try {
        await action();
        actionCompleted = true;
        if (
          !mountedRef.current ||
          operationScope !== currentScopeRef.current ||
          !coordinatorRef.current.owns(token)
        ) {
          return true;
        }

        if (refresh) await refresh();
        if (
          mountedRef.current &&
          operationScope === currentScopeRef.current &&
          coordinatorRef.current.owns(token)
        ) {
          onCompleted?.();
        }
        return true;
      } catch (error) {
        if (
          mountedRef.current &&
          operationScope === currentScopeRef.current &&
          coordinatorRef.current.owns(token)
        ) {
          addToast(
            actionCompleted
              ? intl.formatMessage(messages.refreshFailed)
              : (getServerErrorMessage(error) ??
                  intl.formatMessage(messages.actionFailed, {
                    action: actionLabel.toLocaleLowerCase(),
                  })),
            { appearance: 'error', autoDismiss: false }
          );
        }
        return false;
      } finally {
        if (
          mountedRef.current &&
          operationScope === currentScopeRef.current &&
          coordinatorRef.current.finish(token)
        ) {
          setPendingKeys((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [addToast, intl]
  );

  return {
    isPending: useCallback(
      (key: string) => pendingKeys.has(key),
      [pendingKeys]
    ),
    run,
  };
};

export default useLibraryIndividualActions;
