import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestModal.LoadError', {
  unableToLoad:
    'Unable to load authoritative availability and request information.',
  retryHelp: 'Try again before submitting this request.',
});

interface RequestModalLoadErrorProps {
  title: string;
  subTitle?: string;
  onCancel?: () => void;
  onRetry: () => void;
  retrying: boolean;
  backdrop?: string;
}

const RequestModalLoadError = ({
  title,
  subTitle,
  onCancel,
  onRetry,
  retrying,
  backdrop,
}: RequestModalLoadErrorProps) => {
  const intl = useIntl();

  return (
    <Modal
      title={title}
      subTitle={subTitle}
      onCancel={retrying ? undefined : onCancel}
      onOk={onRetry}
      okDisabled={retrying}
      okText={intl.formatMessage(
        retrying ? globalMessages.retrying : globalMessages.retry
      )}
      backdrop={backdrop}
      backgroundClickable={!retrying}
    >
      <Alert type="error" title={intl.formatMessage(messages.unableToLoad)}>
        {intl.formatMessage(messages.retryHelp)}
      </Alert>
    </Modal>
  );
};

export default RequestModalLoadError;
