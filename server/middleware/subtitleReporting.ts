import type { Request } from 'express';

export const SUBTITLE_REPORT_PATH =
  '/api/v1/integrations/jellyfin/subtitle-issues';

// Only this token-only route is exempt from cookie CSRF. Its handler neither
// reads sessions/API keys nor accepts simple browser requests. Other routes
// retain the application's normal CSRF protection.
export function isSubtitleReportRequest(req: Request): boolean {
  return (
    req.path === SUBTITLE_REPORT_PATH &&
    (req.method === 'POST' || req.method === 'OPTIONS')
  );
}
