import { CogIcon } from '@heroicons/react/24/solid';
import Link from 'next/link';

export const FRESH_CANDIDATE_DIAGNOSTICS_PATH =
  '/settings/discovery-sources/fresh#candidates';

const CandidateDiagnosticsShortcut = ({ show }: { show: boolean }) => {
  if (!show) return null;
  return (
    <Link
      href={FRESH_CANDIDATE_DIAGNOSTICS_PATH}
      aria-label="Open Fresh Candidate Diagnostics"
      className="inline-flex items-center rounded-md border border-gray-600 bg-gray-800/80 px-3 py-2 text-sm font-medium text-gray-200 transition hover:border-gray-600 hover:bg-gray-700 hover:text-white"
    >
      <CogIcon className="mr-2 h-5 w-5" />
      Candidate Diagnostics
    </Link>
  );
};

export default CandidateDiagnosticsShortcut;
