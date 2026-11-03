import { CircleStackIcon } from '@heroicons/react/24/solid';

interface MediaTypeFilterOption {
  value: string;
  label: string;
}

interface MediaTypeFilterProps {
  id?: string;
  value: string;
  options: MediaTypeFilterOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

const MediaTypeFilter = ({
  id,
  value,
  options,
  onChange,
  ariaLabel,
}: MediaTypeFilterProps) => (
  <div className="flex">
    <span className="inline-flex shrink-0 cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
      <CircleStackIcon className="h-6 w-6" />
    </span>
    <select
      id={id}
      name={id}
      className="rounded-r-only"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option value={option.value} key={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </div>
);

export default MediaTypeFilter;
