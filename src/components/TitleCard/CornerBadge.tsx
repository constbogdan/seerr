import type { ReactNode } from 'react';

type TitleCardCornerBadgeTone = 'movie' | 'series' | 'owner';

type TitleCardCornerBadgeProps = {
  children: ReactNode;
  className?: string;
  tone: TitleCardCornerBadgeTone;
};

const toneClasses: Record<TitleCardCornerBadgeTone, string> = {
  movie: 'bg-blue-600/80 text-white',
  series: 'bg-purple-600/80 text-white',
  owner: 'bg-gray-900/80 text-gray-200',
};

const TitleCardCornerBadge = ({
  children,
  className = '',
  tone,
}: TitleCardCornerBadgeProps) => (
  <div
    className={`inline-flex h-7 max-w-full items-center rounded-md px-2 text-xs font-medium leading-5 shadow-md ${
      tone === 'owner' ? '' : 'uppercase tracking-wider'
    } ${toneClasses[tone]} ${className}`}
    data-title-card-corner-badge={tone}
  >
    <span className="truncate">{children}</span>
  </div>
);

export default TitleCardCornerBadge;
