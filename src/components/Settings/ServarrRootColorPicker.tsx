import defineMessages from '@app/utils/defineMessages';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { CheckIcon, XMarkIcon } from '@heroicons/react/24/solid';
import {
  STORAGE_ROOT_COLOR_PALETTE,
  type StorageRootColor,
} from '@server/constants/storageRoot';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.ServarrRootColorPicker', {
  color: 'Storage color',
  defaultColor: 'Use default color',
});

interface ServarrRootColorPickerProps {
  value: StorageRootColor | null;
  onChange: (value: StorageRootColor | null) => void;
}

const ServarrRootColorPicker = ({
  value,
  onChange,
}: ServarrRootColorPickerProps) => {
  const intl = useIntl();
  const colorLabel = intl.formatMessage(messages.color);

  return (
    <Menu as="div" className="relative flex-shrink-0">
      <MenuButton
        type="button"
        aria-label={colorLabel}
        title={colorLabel}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-gray-600 bg-gray-800 transition hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span
          className="h-4 w-4 rounded-full border border-white/30 bg-gray-500"
          style={value ? { backgroundColor: value } : undefined}
        />
      </MenuButton>
      <MenuItems className="absolute right-0 z-50 mt-2 grid w-36 grid-cols-4 gap-1.5 rounded-md border border-gray-600 bg-gray-800 p-2 shadow-xl focus:outline-none">
        <MenuItem>
          <button
            type="button"
            aria-label={intl.formatMessage(messages.defaultColor)}
            title={intl.formatMessage(messages.defaultColor)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-500 bg-gray-700 text-gray-300 hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            onClick={() => onChange(null)}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </MenuItem>
        {STORAGE_ROOT_COLOR_PALETTE.map((color) => (
          <MenuItem key={color}>
            <button
              type="button"
              aria-label={`${colorLabel} ${color}`}
              title={color}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-white/20 hover:border-white/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              style={{ backgroundColor: color }}
              onClick={() => onChange(color)}
            >
              {value === color && (
                <CheckIcon className="h-4 w-4 text-gray-950" />
              )}
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
};

export default ServarrRootColorPicker;
