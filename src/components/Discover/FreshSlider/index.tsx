import { FRESH_API_PATH } from '@app/components/Fresh/api';
import MediaSlider from '@app/components/MediaSlider';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.FreshSlider', {
  fresh: 'Fresh',
});

const FreshSlider = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  if (!currentSettings.freshEnabled) return null;

  return (
    <MediaSlider
      sliderKey="fresh"
      title={intl.formatMessage(messages.fresh)}
      url={FRESH_API_PATH}
      linkUrl="/fresh"
      hideWhenEmpty
    />
  );
};

export default FreshSlider;
