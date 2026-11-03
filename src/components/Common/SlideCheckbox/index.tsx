type SlideCheckboxProps = {
  onClick: () => void;
  checked?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
};

const SlideCheckbox = ({
  onClick,
  checked = false,
  ariaLabel,
  disabled = false,
}: SlideCheckboxProps) => {
  return (
    <span
      role="checkbox"
      tabIndex={disabled ? -1 : 0}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === 'Space')) {
          onClick();
        }
      }}
      className={`relative inline-flex h-5 w-10 flex-shrink-0 items-center justify-center pt-2 focus:outline-none ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
    >
      <span
        aria-hidden="true"
        className={`${
          checked ? 'bg-indigo-500' : 'bg-gray-700'
        } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
      />
      <span
        aria-hidden="true"
        className={`${
          checked ? 'translate-x-5' : 'translate-x-0'
        } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
      />
    </span>
  );
};

export default SlideCheckbox;
