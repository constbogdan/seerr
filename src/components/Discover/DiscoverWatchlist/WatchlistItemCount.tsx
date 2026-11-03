import { useIntl } from 'react-intl';
// Client unit tests execute under the server test tsconfig, which has no @app alias.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import defineMessages from '../../../utils/defineMessages';

const messages = defineMessages(
  'components.Discover.DiscoverWatchlist.ItemCount',
  {
    items: '{count, plural, one {# item} other {# items}}',
  }
);

interface WatchlistItemCountProps {
  count?: number;
  loading: boolean;
}

const WatchlistItemCount = ({ count, loading }: WatchlistItemCountProps) => {
  const intl = useIntl();

  if (loading || count === undefined) return null;

  return (
    <span
      className="text-base font-normal text-gray-400 sm:text-lg"
      data-testid="watchlist-filtered-item-count"
    >
      {intl.formatMessage(messages.items, { count })}
    </span>
  );
};

export default WatchlistItemCount;
