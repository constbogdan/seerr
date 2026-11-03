import Library from '@app/components/Library';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@server/lib/permissions';
import type { NextPage } from 'next';

const LibraryPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <Library />;
};

export default LibraryPage;
