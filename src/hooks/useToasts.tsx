import Toast from '@app/components/Toast';
import {
  shouldAutoDismissToast,
  ToastDismissalManager,
  TRANSIENT_TOAST_DURATION_MS,
} from '@app/hooks/toastLifecycle';
import { useCallback } from 'react';
import { toast } from 'react-hot-toast';

interface ToastOptions {
  appearance?: 'success' | 'error' | 'info' | 'warning';
  autoDismiss?: boolean;
}

const toastDismissals = new ToastDismissalManager();

const dismissToast = (id: string): void => {
  toastDismissals.cancel(id);
  toast.dismiss(id);
};

export const useToasts = () => {
  const addToast = useCallback(
    (
      message: React.ReactNode,
      options?: ToastOptions,
      callback?: (id: string) => void
    ) => {
      const id = toast.custom(
        (t) => {
          // Our custom Toast component handles transitionState internally using `t.visible`
          // We will pass appearance from options
          return (
            <Toast
              appearance={options?.appearance || 'info'}
              onDismiss={() => dismissToast(t.id)}
              transitionState={t.visible ? 'entered' : 'exiting'}
            >
              {message}
            </Toast>
          );
        },
        {
          // Seerr owns transient dismissal so a touch-generated mouse-enter
          // cannot leave react-hot-toast's global hover pause latched.
          duration: Infinity,
        }
      );

      if (shouldAutoDismissToast(options?.autoDismiss)) {
        toastDismissals.schedule(
          id,
          (toastId) => toast.dismiss(toastId),
          TRANSIENT_TOAST_DURATION_MS
        );
      }

      if (callback) {
        callback(id);
      }
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    dismissToast(id);
  }, []);

  return { addToast, removeToast };
};

export default useToasts;
