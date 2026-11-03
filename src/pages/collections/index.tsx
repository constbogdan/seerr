import Collections from '@app/components/Collections';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@server/lib/permissions';
import type { NextPage } from 'next';

const CollectionsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <Collections />;
};

export default CollectionsPage;
