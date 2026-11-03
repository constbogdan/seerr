import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { CalendarIcon } from '@heroicons/react/24/solid';
import type { KeyboardEventHandler, MouseEventHandler } from 'react';

interface CancelScheduledRemovalButtonProps {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  preserveColorsOnInteraction?: boolean;
}

const CancelScheduledRemovalButton = ({
  label,
  onClick,
  onKeyDown,
  disabled = false,
  preserveColorsOnInteraction = false,
}: CancelScheduledRemovalButtonProps) => (
  <Tooltip content={label}>
    <Button
      aria-label={label}
      buttonType="default"
      buttonSize="sm"
      className={`h-7 w-7 border-transparent bg-blue-900/50 !p-0 text-blue-200 ${
        preserveColorsOnInteraction
          ? 'bg-blue-800/80 text-white hover:border-transparent hover:bg-blue-800/80 hover:text-white focus:bg-blue-800/80 focus:text-white group-hover:border-transparent group-hover:bg-blue-800/80 group-hover:text-white'
          : 'hover:bg-blue-800/80 focus:bg-blue-800/80'
      }`}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <CalendarIcon className="h-4 w-4" />
    </Button>
  </Tooltip>
);

export default CancelScheduledRemovalButton;
