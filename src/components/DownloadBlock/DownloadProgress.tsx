interface DownloadProgressProps {
  determinate: boolean;
  progress?: number;
}

const DownloadProgress = ({ determinate, progress }: DownloadProgressProps) => (
  <div
    className="relative mb-2 h-6 min-w-0 overflow-hidden rounded-full bg-gray-700"
    role="progressbar"
    {...(determinate && progress !== undefined
      ? {
          'aria-valuemax': 100,
          'aria-valuemin': 0,
          'aria-valuenow': progress,
        }
      : {})}
  >
    {determinate ? (
      progress !== undefined && (
        <>
          <div
            className="h-full bg-indigo-600 transition-all duration-200 ease-in-out"
            style={{ width: `${progress}%` }}
          />
          <div className="absolute inset-0 flex h-6 w-full items-center justify-center text-xs">
            <span>{progress}%</span>
          </div>
        </>
      )
    ) : (
      <div className="h-full w-full animate-pulse bg-indigo-600/80" />
    )}
  </div>
);

export default DownloadProgress;
