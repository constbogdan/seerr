import { BookmarkIcon as BookmarkIconOutline } from '@heroicons/react/24/outline';
import { BookmarkIcon as BookmarkIconSolid } from '@heroicons/react/24/solid';

interface WatchlistIconProps {
  isWatchlisted: boolean;
  className?: string;
}

export const getWatchlistIcon = (isWatchlisted: boolean) =>
  isWatchlisted ? BookmarkIconSolid : BookmarkIconOutline;

const WatchlistIcon = ({ isWatchlisted, className }: WatchlistIconProps) => {
  const Icon = getWatchlistIcon(isWatchlisted);

  return <Icon className={className} />;
};

export default WatchlistIcon;
