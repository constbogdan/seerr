import { SubtitleJellyfin } from '@server/api/subtitleJellyfin';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { getSubtitleReportingOrigin } from '@server/lib/settings/subtitleReporting';
import {
  reportSubtitleIssue,
  resolveSubtitleItem,
  SubtitleReportError,
} from '@server/lib/subtitleIssue';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import { Router } from 'express';
import { LRUCache } from 'lru-cache';

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

function configuredUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SubtitleReportError(
      503,
      'Subtitle reporting URLs are not configured.'
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new SubtitleReportError(
      503,
      'Subtitle reporting URLs are not configured safely.'
    );
  }
  return url;
}

function configuration() {
  const settings = getSettings();
  if (settings.jellyfin.subtitleReportingEnabled !== true) {
    throw new SubtitleReportError(403, 'Subtitle reporting is disabled.');
  }
  const { ip, port, useSsl, urlBase, externalHostname } = settings.jellyfin;
  const server = configuredUrl(
    `${useSsl ? 'https' : 'http'}://${ip}:${port}${urlBase || ''}`
  );
  const browser = getSubtitleReportingOrigin(externalHostname);
  if (!browser) {
    throw new SubtitleReportError(
      503,
      'A safe HTTPS Jellyfin Web origin must be configured.'
    );
  }
  const application = configuredUrl(settings.main.applicationUrl);
  if (
    application.protocol !== 'https:' &&
    !loopback.has(application.hostname)
  ) {
    throw new SubtitleReportError(
      503,
      'Remote subtitle reporting requires configured HTTPS URLs.'
    );
  }
  return { server: server.href, browser, application };
}

// Bounded per-process abuse protection, not a durable identity/token store.
// Native clients still authenticate; absence of Origin grants no privileges.
export function createSubtitleReportingRoutes() {
  const router = Router();
  const counts = new LRUCache<string, number>({
    max: 4096,
    ttl: 60_000,
    updateAgeOnGet: false,
  });
  let windowStart = 0;
  let globalCount = 0;
  let active = 0;
  const consume = (key: string, maximum: number) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count, { noUpdateTTL: true });
    if (count > maximum)
      throw new SubtitleReportError(
        429,
        'Too many subtitle reports. Try again later.'
      );
  };
  router.use(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    try {
      if (req.method !== 'POST' && req.method !== 'OPTIONS') {
        return res.sendStatus(405);
      }
      const config = configuration();
      const origin = req.get('Origin');
      if (origin !== undefined && origin !== config.browser) {
        throw new SubtitleReportError(403, 'Browser origin is not permitted.');
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', config.browser);
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type'
        );
        // Intentionally no Allow-Credentials: cookies are never authentication.
      }
      if (
        !req.secure &&
        !(
          loopback.has(config.application.hostname) &&
          ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
            req.socket.remoteAddress ?? ''
          )
        )
      ) {
        throw new SubtitleReportError(403, 'HTTPS is required.');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      if (Date.now() - windowStart >= 60_000) {
        windowStart = Date.now();
        globalCount = 0;
      }
      globalCount += 1;
      if (globalCount > 120 || active >= 8)
        throw new SubtitleReportError(
          429,
          'Subtitle reporting is busy. Try again later.'
        );
      consume(`ip:${req.ip}`, 30);
      const authorization = req
        .get('Authorization')
        ?.match(/^Bearer ([A-Za-z0-9._~-]{1,512})$/);
      if (!authorization)
        throw new SubtitleReportError(
          401,
          'A Jellyfin Bearer token is required.'
        );
      if (
        !req.is('application/json') ||
        Object.keys(req.query).length ||
        !req.body ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 ||
        typeof req.body.itemId !== 'string'
      ) {
        throw new SubtitleReportError(
          400,
          'Only a Jellyfin itemId JSON field is accepted.'
        );
      }
      const itemId = normalizeJellyfinGuid(req.body.itemId);
      if (!itemId)
        throw new SubtitleReportError(
          400,
          'A valid Jellyfin itemId is required.'
        );
      active += 1;
      try {
        const jellyfin = new SubtitleJellyfin(config.server, authorization[1]);
        const verified = await jellyfin.getUser();
        const userId = normalizeJellyfinGuid(verified.Id);
        if (!userId || verified.Policy?.IsDisabled !== false) {
          throw new SubtitleReportError(
            401,
            'An enabled Jellyfin user is required.'
          );
        }
        const user = await getRepository(User)
          .createQueryBuilder('user')
          .where(
            'LOWER(REPLACE(user.jellyfinUserId, :hyphen, :empty)) = :userId',
            {
              hyphen: '-',
              empty: '',
              userId,
            }
          )
          .getOne();
        if (
          !user ||
          !user.hasPermission(
            [Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES],
            { type: 'or' }
          )
        ) {
          throw new SubtitleReportError(
            403,
            'A linked Seerr account with issue permission is required.'
          );
        }
        consume(`user:${user.id}`, 10);
        const target = await resolveSubtitleItem(itemId, (id) =>
          jellyfin.getItem(userId, id)
        );
        const result = await reportSubtitleIssue(
          target,
          user,
          itemId,
          config.application.href
        );
        return res.status(result.status === 'created' ? 201 : 200).json(result);
      } finally {
        active -= 1;
      }
    } catch (error) {
      // Never pass provider/DB error objects to the global error handler/logger.
      if (error instanceof SubtitleReportError) {
        if (error.status === 429) res.setHeader('Retry-After', '60');
        return res.status(error.status).json({ message: error.message });
      }
      return res.status(503).json({
        message: 'Subtitle report could not be saved. Please retry later.',
      });
    }
  });
  return router;
}

export default createSubtitleReportingRoutes();
