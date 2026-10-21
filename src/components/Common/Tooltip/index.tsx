import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { Config, TriggerType } from 'react-popper-tooltip';
import { usePopperTooltip } from 'react-popper-tooltip';

type TooltipProps = {
  content: React.ReactNode;
  children: React.ReactElement<Record<string, unknown>>;
  tooltipConfig?: Partial<Config>;
  className?: string;
};

type PositionedTooltipProps = Omit<TooltipProps, 'children'> & {
  cancelPending: () => void;
  close: () => void;
  deactivate: () => void;
  dismiss: () => void;
  triggerElement: HTMLElement | null;
  pointerPosition: React.MutableRefObject<{ x: number; y: number } | null>;
};

const assignRef = (
  ref: React.Ref<HTMLElement> | undefined,
  node: HTMLElement | null
) => {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref) {
    (ref as React.MutableRefObject<HTMLElement | null>).current = node;
  }
};

const PositionedTooltip = ({
  triggerElement,
  content,
  tooltipConfig,
  className,
  cancelPending,
  close,
  deactivate,
  dismiss,
  pointerPosition,
}: PositionedTooltipProps) => {
  const onVisibleChange = tooltipConfig?.onVisibleChange;
  const { getTooltipProps, setTooltipRef, setTriggerRef, triggerRef } =
    usePopperTooltip({
      followCursor: true,
      offset: [-28, 6],
      placement: 'auto-end',
      ...tooltipConfig,
      defaultVisible: undefined,
      onVisibleChange: (nextVisible) => {
        onVisibleChange?.(nextVisible);
        if (!nextVisible) deactivate();
      },
      trigger: null,
      visible: true,
    });

  useEffect(() => {
    setTriggerRef(triggerElement);
    return () => setTriggerRef(null);
  }, [setTriggerRef, triggerElement]);

  useEffect(() => {
    const position = pointerPosition.current;
    if (tooltipConfig?.followCursor === false || !triggerRef || !position) {
      return;
    }

    triggerRef.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: position.x,
        clientY: position.y,
      })
    );
  }, [pointerPosition, tooltipConfig?.followCursor, triggerRef]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [dismiss]);

  const tooltipStyle = [
    'z-50 text-sm absolute font-normal bg-gray-800 px-2 py-1 rounded border border-gray-600 shadow text-gray-100',
  ];

  if (className) {
    tooltipStyle.push(className);
  }

  return (
    content &&
    ReactDOM.createPortal(
      <div
        ref={setTooltipRef}
        {...getTooltipProps({
          className: tooltipStyle.join(' '),
          ...(tooltipConfig?.interactive
            ? {
                onMouseEnter: cancelPending,
                onMouseLeave: close,
              }
            : {}),
          role: 'tooltip',
        })}
      >
        {content}
      </div>,
      document.body
    )
  );
};

const Tooltip = ({
  children,
  content,
  tooltipConfig,
  className,
}: TooltipProps) => {
  const [localVisible, setLocalVisible] = useState(
    tooltipConfig?.defaultVisible ?? false
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerPosition = useRef<{ x: number; y: number } | null>(null);
  const [triggerElement, setTriggerElement] = useState<HTMLElement | null>(
    null
  );
  const configuredVisible = tooltipConfig?.visible;
  const visible = configuredVisible ?? localVisible;
  const configuredTrigger = tooltipConfig?.trigger ?? ['hover', 'focus'];
  const triggers = Array.isArray(configuredTrigger)
    ? configuredTrigger
    : configuredTrigger
      ? [configuredTrigger]
      : [];
  const hasTrigger = (trigger: TriggerType) => triggers.includes(trigger);
  const changeVisibility = useCallback(
    (nextVisible: boolean) => {
      if (configuredVisible === undefined) setLocalVisible(nextVisible);
      tooltipConfig?.onVisibleChange?.(nextVisible);
    },
    [configuredVisible, tooltipConfig]
  );
  const cancelPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const scheduleVisibility = useCallback(
    (nextVisible: boolean) => {
      cancelPending();
      const delay = nextVisible
        ? (tooltipConfig?.delayShow ?? 0)
        : (tooltipConfig?.delayHide ?? 0);
      timer.current = setTimeout(() => changeVisibility(nextVisible), delay);
    },
    [
      cancelPending,
      changeVisibility,
      tooltipConfig?.delayHide,
      tooltipConfig?.delayShow,
    ]
  );
  const close = useCallback(
    () => scheduleVisibility(false),
    [scheduleVisibility]
  );
  const deactivate = useCallback(() => {
    cancelPending();
    if (configuredVisible === undefined) setLocalVisible(false);
  }, [cancelPending, configuredVisible]);
  const dismiss = useCallback(() => {
    cancelPending();
    changeVisibility(false);
  }, [cancelPending, changeVisibility]);

  useEffect(() => cancelPending, [cancelPending]);

  const childProps = children.props;
  const childRef = childProps.ref as React.Ref<HTMLElement> | undefined;
  const mergedTriggerRef = useCallback(
    (node: HTMLElement | null) => {
      setTriggerElement(node);
      assignRef(childRef, node);
    },
    [childRef]
  );
  const callChildHandler = (
    name: string,
    event: React.SyntheticEvent<HTMLElement>
  ) => {
    const handler = childProps[name];
    if (typeof handler === 'function') handler(event);
  };
  const triggerProps: Record<string, unknown> = {
    ...((typeof content === 'string' || typeof content === 'number') &&
    !childProps['aria-label'] &&
    !childProps['aria-labelledby']
      ? { 'aria-label': String(content) }
      : {}),
  };

  if (hasTrigger('focus')) {
    triggerProps.onBlur = (event: React.FocusEvent<HTMLElement>) => {
      callChildHandler('onBlur', event);
      scheduleVisibility(false);
    };
    triggerProps.onFocus = (event: React.FocusEvent<HTMLElement>) => {
      callChildHandler('onFocus', event);
      if (event.currentTarget.matches(':focus-visible')) {
        scheduleVisibility(true);
      }
    };
  }

  if (hasTrigger('click')) {
    triggerProps.onClick = (event: React.MouseEvent<HTMLElement>) => {
      callChildHandler('onClick', event);
      scheduleVisibility(!visible);
    };
  }

  if (hasTrigger('right-click')) {
    triggerProps.onContextMenu = (event: React.MouseEvent<HTMLElement>) => {
      callChildHandler('onContextMenu', event);
      event.preventDefault();
      scheduleVisibility(!visible);
    };
  }

  if (hasTrigger('double-click')) {
    triggerProps.onDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
      callChildHandler('onDoubleClick', event);
      scheduleVisibility(!visible);
    };
  }

  if (!hasTrigger('click')) {
    triggerProps.onClick = (event: React.MouseEvent<HTMLElement>) => {
      callChildHandler('onClick', event);
      dismiss();
    };
  }

  if (hasTrigger('hover')) {
    triggerProps.onPointerEnter = (event: React.PointerEvent<HTMLElement>) => {
      callChildHandler('onPointerEnter', event);
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      if (event.pointerType !== 'touch') scheduleVisibility(true);
    };
    triggerProps.onPointerLeave = (event: React.PointerEvent<HTMLElement>) => {
      callChildHandler('onPointerLeave', event);
      if (event.pointerType !== 'touch') scheduleVisibility(false);
    };
    triggerProps.onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
      callChildHandler('onPointerMove', event);
      pointerPosition.current = { x: event.clientX, y: event.clientY };
    };
    triggerProps.onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
      callChildHandler('onPointerDown', event);
      if (event.pointerType === 'touch') scheduleVisibility(true);
    };
  }

  const trigger = React.cloneElement(children, {
    ...triggerProps,
    ref: mergedTriggerRef,
  });

  return (
    <>
      {trigger}
      {visible && content && (
        <PositionedTooltip
          className={className}
          cancelPending={cancelPending}
          close={close}
          content={content}
          deactivate={deactivate}
          dismiss={dismiss}
          pointerPosition={pointerPosition}
          tooltipConfig={tooltipConfig}
          triggerElement={triggerElement}
        />
      )}
    </>
  );
};

export default Tooltip;
