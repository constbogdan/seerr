import cookieParser from 'cookie-parser';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = path.join(__dirname, '../../seerr-api.yml');

describe('OpenAPI runtime schema', () => {
  it('is accepted by the same middleware Seerr installs at runtime', async () => {
    const app = express();
    app.use(cookieParser());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
      })
    );
    app.get('/api/v1/fresh', (_req, res) => res.status(200).json({ ok: true }));
    app.use(
      (
        error: { message?: string; status?: number },
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        void next;
        return res.status(error.status ?? 500).json({ message: error.message });
      }
    );

    const authenticatedGet = (requestPath: string) =>
      request(app).get(requestPath).set('Cookie', 'connect.sid=test-session');
    const response = await authenticatedGet('/api/v1/fresh');
    assert.equal(response.status, 200, response.body?.message);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(
      (
        await authenticatedGet(
          '/api/v1/fresh?page=1&mediaType=movie&sort=vote_average.desc'
        )
      ).status,
      200
    );
    assert.equal((await authenticatedGet('/api/v1/fresh?page=0')).status, 400);
    assert.equal(
      (await authenticatedGet('/api/v1/fresh?unknown=true')).status,
      400
    );
  });
});
