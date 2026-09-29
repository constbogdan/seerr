import freshService, {
  normalizeFreshSettings,
  publicFreshSettings,
} from '@server/lib/fresh/service';
import { getSettings, type FreshSettings } from '@server/lib/settings';
import { Router } from 'express';
import { z } from 'zod';

const freshSettingsRoutes = Router();

const FreshSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().max(2048),
    apiToken: z.string().max(4096).optional(),
    filterId: z.number().int().nonnegative(),
    cachedFilterName: z.string().max(200),
    mediaEligibilityDays: z.number().int().min(1).max(365),
    freshVisibilityDays: z.number().int().min(1).max(90),
    includeGenreIds: z.array(z.number().int().positive()),
    excludeGenreIds: z.array(z.number().int().positive()),
    includeOriginalLanguages: z.array(z.string().max(16)),
    excludeOriginalLanguages: z.array(z.string().max(16)),
    includeContentRatings: z.array(z.string().max(40)),
    excludeContentRatings: z.array(z.string().max(40)),
    minimumTmdbScore: z.number().min(0).max(10),
    minimumTmdbVotes: z.number().int().min(0).max(10000000),
  })
  .strict();

const FreshConnectionSchema = z
  .object({
    baseUrl: z.string().max(2048).optional(),
    apiToken: z.string().max(4096).optional(),
  })
  .strict();

const mergedConnectionSettings = (body: unknown): FreshSettings => {
  const settings = getSettings().fresh;
  const value = FreshConnectionSchema.parse(body);
  return {
    ...settings,
    baseUrl: value.baseUrl?.trim() || settings.baseUrl,
    apiToken: value.apiToken?.trim() ? value.apiToken : settings.apiToken,
  };
};

export const mergeFreshSettingsUpdate = (
  current: FreshSettings,
  body: unknown
): FreshSettings => {
  const update = FreshSettingsUpdateSchema.parse(body);
  return normalizeFreshSettings({
    ...update,
    apiToken: update.apiToken?.trim() ? update.apiToken : current.apiToken,
  });
};

freshSettingsRoutes.get('/', (_req, res) => {
  return res.status(200).json(publicFreshSettings(getSettings().fresh));
});

freshSettingsRoutes.put('/', async (req, res, next) => {
  try {
    const settings = getSettings();
    const fresh = mergeFreshSettingsUpdate(settings.fresh, req.body);
    settings.fresh = fresh;
    await settings.save();
    freshService.configure(settings.fresh);
    if (settings.fresh.enabled) await freshService.reevaluate();
    return res.status(200).json(publicFreshSettings(settings.fresh));
  } catch {
    return next({ status: 400, message: 'Invalid Fresh settings.' });
  }
});

freshSettingsRoutes.post('/test', async (req, res, next) => {
  try {
    await freshService.test(mergedConnectionSettings(req.body));
    return res.status(200).json({ success: true });
  } catch {
    return next({ status: 500, message: 'Unable to connect to autobrr.' });
  }
});

freshSettingsRoutes.post('/filters', async (req, res, next) => {
  try {
    const settings = getSettings();
    const filters = await freshService.filters(
      mergedConnectionSettings(req.body)
    );
    const configured = filters.find(
      (filter) => filter.id === settings.fresh.filterId
    );
    if (configured && settings.fresh.cachedFilterName !== configured.name) {
      settings.fresh = { ...settings.fresh, cachedFilterName: configured.name };
      await settings.save();
      freshService.configure(settings.fresh);
    }
    return res.status(200).json(filters);
  } catch {
    return next({
      status: 500,
      message: 'Unable to retrieve autobrr filters.',
    });
  }
});

freshSettingsRoutes.get('/status', async (_req, res) => {
  return res.status(200).json(await freshService.status());
});

freshSettingsRoutes.get('/diagnostics', async (_req, res) => {
  return res.status(200).json(await freshService.diagnostics());
});

const CandidateQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    search: z.string().max(300).optional(),
    mediaType: z.enum(['all', 'movie', 'tv']).default('all'),
    status: z
      .enum([
        'all',
        'resolved',
        'no_match',
        'ambiguous',
        'temporary_failure',
        'pending',
        'resolving',
        'outside_eligibility_window',
        'eligibility_unknown',
        'excluded_content_filter',
        'visibility_expired',
        'active_fresh',
        'needs_attention',
        'reviewable',
        'historical',
      ])
      .default('all'),
    sort: z
      .enum([
        'priority',
        'title.asc',
        'title.desc',
        'status',
        'year.desc',
        'year.asc',
        'first_seen.desc',
        'first_seen.asc',
        'last_seen.desc',
        'last_seen.asc',
      ])
      .default('priority'),
    reasonFamily: z
      .enum(['all', 'resolution', 'admission', 'content', 'history', 'source'])
      .default('all'),
    seasonEvidence: z.enum(['all', 'known', 'unknown']).default('all'),
    manualResolution: z.enum(['all', 'present', 'absent']).default('all'),
    admissionOverride: z.enum(['all', 'present', 'absent']).default('all'),
  })
  .strict();

freshSettingsRoutes.get('/candidates', async (req, res, next) => {
  try {
    return res
      .status(200)
      .json(
        await freshService.candidateDiagnostics(
          CandidateQuerySchema.parse(req.query)
        )
      );
  } catch {
    return next({ status: 400, message: 'Invalid candidate query.' });
  }
});

freshSettingsRoutes.post('/candidates/:id/resolve', async (req, res, next) => {
  try {
    const candidateId = z.coerce.number().int().positive().parse(req.params.id);
    const { mediaType, tmdbId, expectedRevision } = z
      .object({
        mediaType: z.enum(['movie', 'tv']),
        tmdbId: z.number().int().positive(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const result = await freshService.resolveCandidate(
      candidateId,
      mediaType,
      tmdbId,
      expectedRevision,
      req.user?.id
    );
    return res.status(200).json({
      candidateId: result.candidate.id,
      parsedMediaType: result.candidate.mediaType,
      mediaType: result.media.mediaType,
      tmdbId: result.media.tmdbId,
      title: result.media.displayTitle,
      mediaDate: result.media.mediaDate ?? null,
      status: result.candidate.status,
      active: result.media.active,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next({ status: 400, message: 'Invalid TMDB resolution.' });
    }
    const code = error instanceof Error ? error.message : '';
    if (
      [
        'candidate_not_found',
        'candidate_not_actionable',
        'candidate_not_current',
        'stale_candidate',
        'source_evidence_collision',
      ].includes(code)
    ) {
      return next({
        status: code === 'candidate_not_found' ? 404 : 409,
        message: 'Candidate cannot be resolved.',
      });
    }
    if (
      [
        'invalid_candidate',
        'invalid_tmdb_id',
        'invalid_tmdb_response',
        'invalid_media_type',
        'invalid_revision',
      ].includes(code)
    ) {
      return next({ status: 400, message: 'Invalid TMDB resolution.' });
    }
    return next({
      status: 502,
      message: 'Unable to validate the TMDB identity.',
    });
  }
});

const CandidateMutationSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

freshSettingsRoutes.post(
  '/candidates/:id/reset-resolution',
  async (req, res, next) => {
    try {
      const candidateId = z.coerce
        .number()
        .int()
        .positive()
        .parse(req.params.id);
      const { expectedRevision } = CandidateMutationSchema.parse(req.body);
      const candidate = await freshService.resetCandidateResolution(
        candidateId,
        expectedRevision
      );
      return res
        .status(200)
        .json({ candidateId, revision: candidate.revision });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return next({
          status: 400,
          message: 'Invalid candidate mutation request.',
        });
      }
      const code = error instanceof Error ? error.message : '';
      return next({
        status: code === 'candidate_not_found' ? 404 : 409,
        message: 'Candidate resolution could not be reset.',
      });
    }
  }
);

freshSettingsRoutes.post('/candidates/:id/admit', async (req, res, next) => {
  try {
    const candidateId = z.coerce.number().int().positive().parse(req.params.id);
    const { expectedRevision } = CandidateMutationSchema.parse(req.body);
    const candidate = await freshService.admitCandidate(
      candidateId,
      expectedRevision,
      req.user?.id
    );
    return res.status(200).json({ candidateId, revision: candidate.revision });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next({
        status: 400,
        message: 'Invalid candidate mutation request.',
      });
    }
    const code = error instanceof Error ? error.message : '';
    return next({
      status: code === 'candidate_not_found' ? 404 : 409,
      message: 'Candidate cannot be admitted to Fresh.',
    });
  }
});

freshSettingsRoutes.post(
  '/candidates/:id/remove-override',
  async (req, res, next) => {
    try {
      const candidateId = z.coerce
        .number()
        .int()
        .positive()
        .parse(req.params.id);
      const { expectedRevision } = CandidateMutationSchema.parse(req.body);
      const candidate = await freshService.removeCandidateOverride(
        candidateId,
        expectedRevision
      );
      return res
        .status(200)
        .json({ candidateId, revision: candidate.revision });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return next({
          status: 400,
          message: 'Invalid candidate mutation request.',
        });
      }
      const code = error instanceof Error ? error.message : '';
      return next({
        status: code === 'candidate_not_found' ? 404 : 409,
        message: 'Fresh admission override could not be removed.',
      });
    }
  }
);

freshSettingsRoutes.post('/refresh', async (_req, res, next) => {
  try {
    await freshService.refresh();
    return res.status(200).json(await freshService.status());
  } catch {
    return next({ status: 500, message: 'Unable to refresh Fresh.' });
  }
});

freshSettingsRoutes.post('/rebuild', async (_req, res, next) => {
  try {
    await freshService.rebuild();
    return res.status(200).json(await freshService.status());
  } catch {
    return next({
      status: 500,
      message: 'Unable to rebuild Fresh data.',
    });
  }
});

export default freshSettingsRoutes;
