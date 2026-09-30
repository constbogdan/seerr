import { CogIcon } from '@heroicons/react/24/solid';
import Link from 'next/link';
// The focused node:test renderer does not resolve @app aliases for this leaf.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import Tooltip from '../Common/Tooltip';

export const FRESH_CANDIDATE_DIAGNOSTICS_PATH =
  '/settings/discovery-sources/fresh#candidates';

const CandidateDiagnosticsShortcut = ({
  show,
  bordered = true,
}: {
  show: boolean;
  bordered?: boolean;
}) => {
  if (!show) return null;
  return (
    <Tooltip content="Candidate Diagnostics">
      <Link
        href={FRESH_CANDIDATE_DIAGNOSTICS_PATH}
        aria-label="Candidate Diagnostics"
        className={`inline-flex h-10 w-10 items-center justify-center rounded-md bg-gray-800/80 text-gray-200 transition hover:bg-gray-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
          bordered ? 'border border-gray-600' : 'border border-transparent'
        }`}
      >
        <CogIcon className="h-5 w-5" />
      </Link>
    </Tooltip>
  );
};

export default CandidateDiagnosticsShortcut;
