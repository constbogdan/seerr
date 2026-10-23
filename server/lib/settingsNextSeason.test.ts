import type { AllSettings } from '@server/lib/settings';
import Settings from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const serializeSettings = (settings: Settings): AllSettings =>
  JSON.parse(
    JSON.stringify((settings as unknown as { data: AllSettings }).data)
  ) as AllSettings;

describe('Next Season settings persistence', () => {
  it('defaults the independent five-minute job to disabled', () => {
    const settings = new Settings();
    assert.deepEqual(settings.jobs['next-season'], {
      schedule: '15 */5 * * * *',
      enabled: false,
    });
  });

  it('loads deployed settings without Next Season using safe defaults', () => {
    const deployed = serializeSettings(new Settings());
    Reflect.deleteProperty(deployed.jobs, 'next-season');

    const loaded = new Settings(deployed);

    assert.deepEqual(loaded.jobs['next-season'], {
      schedule: '15 */5 * * * *',
      enabled: false,
    });
  });

  it('preserves an explicitly enabled state and custom schedule', () => {
    const settings = new Settings();
    settings.jobs['next-season'] = {
      schedule: '45 */10 * * * *',
      enabled: true,
    };

    const loaded = new Settings(serializeSettings(settings));

    assert.deepEqual(loaded.jobs['next-season'], settings.jobs['next-season']);
  });
});
