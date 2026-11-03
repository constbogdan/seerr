import TitleCardCornerBadge from '@app/components/TitleCard/CornerBadge';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.TitleCard.RatingBadge', {
  rating: 'TMDB rating: {rating} out of 10',
});

const TitleCardRatingBadge = ({ score }: { score?: number }) => {
  const intl = useIntl();
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score <= 0 ||
    score > 10
  )
    return null;
  const rating = intl.formatNumber(score, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return (
    <TitleCardCornerBadge tone="neutral" className="h-6 self-end !px-1 !py-0.5">
      <span
        className="block text-white"
        role="img"
        aria-label={intl.formatMessage(messages.rating, { rating })}
        data-testid="title-card-rating"
      >
        <span aria-hidden="true">{rating}</span>
      </span>
    </TitleCardCornerBadge>
  );
};

export default TitleCardRatingBadge;
