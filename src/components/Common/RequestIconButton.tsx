import Button from '@app/components/Common/Button';
import { ArrowDownTrayIcon } from '@heroicons/react/24/solid';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

type RequestIconButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'children'
> & {
  buttonSize?: 'default' | 'lg' | 'md' | 'sm';
  icon?: ReactNode;
};

const RequestIconButton = ({
  buttonSize = 'sm',
  className,
  icon,
  ...props
}: RequestIconButtonProps) => (
  <Button
    buttonType="primary"
    buttonSize={buttonSize}
    className={twMerge(
      'h-7 w-7 rounded-md border-transparent bg-gray-900/90 !p-0 text-purple-400 shadow-md hover:border-transparent hover:bg-gray-700 hover:text-purple-300 focus:border-transparent focus:ring-purple-300 active:border-transparent active:bg-gray-800 active:text-purple-300',
      className
    )}
    {...props}
  >
    {icon ?? <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />}
  </Button>
);

export default RequestIconButton;
