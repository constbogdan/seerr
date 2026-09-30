import type { ReactNode } from 'react';

export type TitleCardOverlayItem = {
  id: string;
  content: ReactNode;
};

type ActionStateGridProps = {
  actions: TitleCardOverlayItem[];
  states: TitleCardOverlayItem[];
};

const ActionStateGrid = ({ actions, states }: ActionStateGridProps) => {
  if (actions.length === 0 && states.length === 0) {
    return null;
  }

  return (
    <div
      className={`pointer-events-none grid auto-rows-[1.75rem] items-start gap-1 ${
        states.length > 0
          ? 'grid-cols-[1.75rem_1.75rem]'
          : 'grid-cols-[1.75rem]'
      }`}
      data-testid="title-card-action-state-grid"
    >
      {actions.map((action, index) => (
        <div
          className="pointer-events-auto flex h-7 w-7 items-center justify-center"
          data-action-slot={action.id}
          key={action.id}
          style={{ gridColumn: 1, gridRow: index + 1 }}
        >
          {action.content}
        </div>
      ))}
      {states.map((state, index) => (
        <div
          className="flex h-7 w-7 items-center justify-center"
          data-state-slot={state.id}
          key={state.id}
          style={{ gridColumn: 2, gridRow: index + 1 }}
        >
          {state.content}
        </div>
      ))}
    </div>
  );
};

export default ActionStateGrid;
