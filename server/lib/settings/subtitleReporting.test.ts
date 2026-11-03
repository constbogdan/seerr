import {
  getSubtitleReportingOrigin,
  isValidSubtitleReportingSettings,
} from '@server/lib/settings/subtitleReporting';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('subtitle reporting configuration', () => {
  it('derives one exact origin from the existing HTTPS External URL, preserving path-based URLs', () => {
    assert.equal(
      getSubtitleReportingOrigin('https://Jellyfin.example.test:8443/web'),
      'https://jellyfin.example.test:8443'
    );
    assert.equal(
      getSubtitleReportingOrigin('https://jellyfin.example.test'),
      'https://jellyfin.example.test'
    );
  });

  it('rejects unsafe, missing and non-HTTPS origins without returning secrets', () => {
    for (const value of [
      undefined,
      null,
      '',
      'null',
      '*',
      'http://localhost:8096',
      'javascript:alert(1)',
      'https://name:secret@jellyfin.test',
      'https://jellyfin.test?token=secret',
      'https://jellyfin.test#secret',
      ' https://jellyfin.test',
      'https://jellyfin.test\n',
    ]) {
      assert.equal(getSubtitleReportingOrigin(value), null);
      assert.equal(
        isValidSubtitleReportingSettings({
          subtitleReportingEnabled: true,
          externalHostname: value,
        }),
        false
      );
    }
  });

  it('keeps legacy HTTP connection settings valid while disabled, but never coerces the enable flag', () => {
    assert.equal(
      isValidSubtitleReportingSettings({
        externalHostname: 'http://existing.test/web',
      }),
      true
    );
    assert.equal(
      isValidSubtitleReportingSettings({ subtitleReportingEnabled: false }),
      true
    );
    for (const value of ['true', 'false', 1, null]) {
      assert.equal(
        isValidSubtitleReportingSettings({
          subtitleReportingEnabled: value,
          externalHostname: 'https://jellyfin.test',
        }),
        false
      );
    }
  });
});
