export const TRANSIENT_TOAST_DURATION_MS = 4000;

type TimerHandle = unknown;
type ScheduleTimer = (callback: () => void, delay: number) => TimerHandle;
type CancelTimer = (handle: TimerHandle) => void;

export class ToastDismissalManager {
  private timers = new Map<string, TimerHandle>();

  constructor(
    private readonly scheduleTimer: ScheduleTimer = (callback, delay) =>
      setTimeout(callback, delay),
    private readonly cancelTimer: CancelTimer = (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>)
  ) {}

  public schedule(
    id: string,
    dismiss: (toastId: string) => void,
    delay = TRANSIENT_TOAST_DURATION_MS
  ): void {
    this.cancel(id);
    const handle = this.scheduleTimer(() => {
      this.timers.delete(id);
      dismiss(id);
    }, delay);
    this.timers.set(id, handle);
  }

  public cancel(id: string): void {
    const handle = this.timers.get(id);
    if (handle === undefined) return;

    this.cancelTimer(handle);
    this.timers.delete(id);
  }
}

export const shouldAutoDismissToast = (autoDismiss?: boolean): boolean =>
  autoDismiss !== false;
