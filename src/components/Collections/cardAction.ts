import type { LibraryCollectionItem } from '@server/interfaces/api/libraryInterfaces';

export type CollectionCardActionPresentation = {
  icon: 'Squares2X2Icon' | 'SquaresPlusIcon';
  label: 'view' | 'request';
  className: string;
};

const silverClassName =
  'text-gray-300 hover:text-white focus:ring-gray-300 active:text-white';

export const getCollectionCardActionPresentation = (
  completeness: LibraryCollectionItem['completeness']
): CollectionCardActionPresentation => {
  if (completeness === 'complete') {
    return {
      icon: 'Squares2X2Icon',
      label: 'view',
      className:
        'text-green-400 hover:text-green-300 focus:ring-green-300 active:text-green-300',
    };
  }

  if (completeness === 'incomplete') {
    return {
      icon: 'SquaresPlusIcon',
      label: 'request',
      className: silverClassName,
    };
  }

  return {
    icon: 'Squares2X2Icon',
    label: 'view',
    className: silverClassName,
  };
};
