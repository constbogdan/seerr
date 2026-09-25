import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getBuildChannel,
  getDownstreamVersion,
  shouldCheckUpstreamVersion,
} from './appVersion';

const commit = '1'.repeat(40);

describe('application build identity', () => {
  it('recognizes explicit, internally consistent downstream metadata', () => {
    const version = getDownstreamVersion(
      { channel: 'downstream', version: 'custom-v1.0.4', commitTag: commit },
      commit
    );

    assert.equal(version, 'custom-v1.0.4');
    assert.equal(getBuildChannel(version, commit, version), 'downstream');
    assert.equal(shouldCheckUpstreamVersion('downstream'), false);
  });

  it('preserves official release, develop, and local channels', () => {
    assert.equal(getBuildChannel('2.7.3', commit, undefined), 'official');
    assert.equal(
      getBuildChannel(`develop-${commit}`, commit, undefined),
      'develop'
    );
    assert.equal(getBuildChannel('develop-local', 'local', undefined), 'local');
    assert.equal(shouldCheckUpstreamVersion('official'), true);
    assert.equal(shouldCheckUpstreamVersion('develop'), true);
    assert.equal(shouldCheckUpstreamVersion('local'), true);
  });

  it('rejects absent, malformed, or mismatched downstream metadata', () => {
    const cases = [
      undefined,
      { channel: 'official', version: 'custom-v1.0.4', commitTag: commit },
      { channel: 'downstream', version: 'develop-current', commitTag: commit },
      {
        channel: 'downstream',
        version: 'custom-v1.0.4',
        commitTag: 'not-a-sha',
      },
      {
        channel: 'downstream',
        version: 'custom-v1.0.4',
        commitTag: '2'.repeat(40),
      },
    ];

    for (const metadata of cases) {
      assert.equal(getDownstreamVersion(metadata, commit), undefined);
    }
  });
});
