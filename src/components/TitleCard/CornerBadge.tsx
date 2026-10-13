import type { ReactNode } from 'react';

type TitleCardCornerBadgeTone = 'movie' | 'series';

type TitleCardCornerBadgeProps = {
  children: ReactNode;
  className?: string;
  tone: TitleCardCornerBadgeTone;
};

const toneClasses: Record<TitleCardCornerBadgeTone, string> = {
  movie: 'text-blue-400',
  series: 'text-purple-400',
};

const TitleCardCornerBadge = ({
  children,
  className = '',
  tone,
}: TitleCardCornerBadgeProps) => (
  <div
    className={`inline-flex max-w-full items-center self-start rounded-md bg-gray-900/90 px-2 py-1 text-center text-xs font-medium shadow-md ${toneClasses[tone]} ${className}`}
    data-title-card-corner-badge={tone}
  >
    <span className="min-w-0 truncate">{children}</span>
  </div>
);

export default TitleCardCornerBadge;
