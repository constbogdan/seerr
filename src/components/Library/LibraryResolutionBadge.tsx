import { TagIcon } from '@heroicons/react/24/solid';

interface LibraryResolutionBadgeProps {
  className?: string;
  label: string;
}

const LibraryResolutionBadge = ({
  className,
  label,
}: LibraryResolutionBadgeProps) => (
  <span
    className={`inline-grid h-5 min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-1.5 whitespace-nowrap text-sm font-normal text-gray-200 ${
      className ?? ''
    }`}
  >
    <span className="inline-flex h-4 w-4 items-center justify-center">
      <TagIcon className="h-4 w-4 text-slate-300" aria-hidden="true" />
    </span>
    <span>{label}</span>
  </span>
);

export default LibraryResolutionBadge;
