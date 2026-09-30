import Spinner from '@app/assets/spinner.svg';
import Tooltip from '@app/components/Common/Tooltip';
import { CheckCircleIcon } from '@heroicons/react/20/solid';
import {
  BellIcon,
  ClockIcon,
  EyeSlashIcon,
  MinusSmallIcon,
  PlayIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';

interface StatusBadgeMiniProps {
  status: MediaStatus | 'watched';
  is4k?: boolean;
  inProgress?: boolean;
  label?: string;
  // Should the badge shrink on mobile to a smaller size? (TitleCard)
  shrink?: boolean;
}

const StatusBadgeMini = ({
  status,
  is4k = false,
  inProgress = false,
  label,
  shrink = false,
}: StatusBadgeMiniProps) => {
  const badgeStyle = [
    `rounded-full shadow-md ${
      shrink ? 'w-4 sm:w-5 border p-0' : 'w-5 ring-1 p-0.5'
    }`,
  ];

  let indicatorIcon: React.ReactNode;
  let indicatorName: string | undefined;

  switch (status) {
    case MediaStatus.PROCESSING:
      badgeStyle.push(
        'bg-indigo-500/80 border-indigo-400 ring-indigo-400 text-indigo-100'
      );
      indicatorIcon = <ClockIcon />;
      indicatorName = 'processing';
      break;
    case MediaStatus.AVAILABLE:
      badgeStyle.push(
        'bg-green-500/80 border-green-400 ring-green-400 text-green-100'
      );
      indicatorIcon = <CheckCircleIcon />;
      indicatorName = 'available';
      break;
    case MediaStatus.PENDING:
      badgeStyle.push(
        'bg-yellow-500/80 border-yellow-400 ring-yellow-400 text-yellow-100'
      );
      indicatorIcon = <BellIcon />;
      indicatorName = 'pending';
      break;
    case MediaStatus.BLOCKLISTED:
      badgeStyle.push('bg-red-500/80 border-white ring-white text-white');
      indicatorIcon = <EyeSlashIcon />;
      indicatorName = 'blocklisted';
      break;
    case MediaStatus.PARTIALLY_AVAILABLE:
      badgeStyle.push(
        'bg-green-500/80 border-green-400 ring-green-400 text-green-100'
      );
      indicatorIcon = <MinusSmallIcon />;
      indicatorName = 'partially-available';
      break;
    case MediaStatus.DELETED:
      badgeStyle.push('bg-red-500/80 border-red-400 ring-red-400 text-red-100');
      indicatorIcon = <TrashIcon />;
      indicatorName = 'removed';
      break;
    case 'watched':
      badgeStyle.push(
        'bg-cyan-500/80 border-cyan-400 ring-cyan-400 text-cyan-100'
      );
      indicatorIcon = <PlayIcon />;
      indicatorName = 'watched';
      break;
  }

  if (inProgress) {
    indicatorIcon = <Spinner />;
    indicatorName = 'in-progress';
  }

  const indicator = (
    <div
      aria-label={label}
      className={`relative inline-flex whitespace-nowrap rounded-full border-gray-700 text-xs font-semibold leading-5 ring-gray-700 ${
        shrink ? '' : 'ring-1'
      }`}
      data-state-indicator={indicatorName}
      role={label ? 'img' : undefined}
    >
      <div className={badgeStyle.join(' ')}>{indicatorIcon}</div>
      {is4k && <span className="pl-1 pr-2 text-gray-200">4K</span>}
    </div>
  );

  return label ? <Tooltip content={label}>{indicator}</Tooltip> : indicator;
};

export default StatusBadgeMini;
