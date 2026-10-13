import { useEffect, useRef } from 'react';

interface LibrarySelectionCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  hitArea?: 'compact' | 'card' | 'season';
  className?: string;
  onChange: (selected: boolean) => void;
}

const hitAreaClasses = {
  compact: 'h-[18px] w-[18px]',
  card: 'h-16 w-9',
  season: 'h-9 w-9',
} as const;

const LibrarySelectionCheckbox = ({
  checked,
  indeterminate = false,
  disabled = false,
  label,
  hitArea = 'compact',
  className,
  onChange,
}: LibrarySelectionCheckboxProps) => {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={`relative !mb-0 inline-flex flex-none items-center justify-center ${hitAreaClasses[hitArea]} ${
        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      {hitArea === 'compact' && (
        <span className="absolute -inset-[7px]" aria-hidden="true" />
      )}
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        className={`relative z-10 !h-[18px] !w-[18px] rounded !border-0 border-transparent bg-gray-700 text-indigo-600 outline-none ring-0 checked:border-transparent focus:border-transparent focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:!ring-2 focus-visible:!ring-indigo-400 focus-visible:!ring-offset-2 focus-visible:!ring-offset-gray-800 disabled:cursor-not-allowed disabled:opacity-40 ${
          className ?? ''
        }`}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
};

export default LibrarySelectionCheckbox;
