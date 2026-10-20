import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isSettingsPath,
  synchronizeSettingsMenuExpansion,
} from './settingsNavigationState';

describe('Settings sidebar expansion state', () => {
  it('matches both General URLs and nested Settings destinations', () => {
    assert.equal(isSettingsPath('/settings'), true);
    assert.equal(isSettingsPath('/settings/main'), true);
    assert.equal(isSettingsPath('/settings/notifications/email'), true);
    assert.equal(isSettingsPath('/discover/movies'), false);
    assert.equal(isSettingsPath('/settings-preview'), false);
  });

  it('automatically expands when entering Settings directly or through history', () => {
    assert.equal(
      synchronizeSettingsMenuExpansion({
        expanded: false,
        wasSettingsPath: false,
        settingsPath: true,
      }),
      true
    );
  });

  it('collapses when navigating away from Settings', () => {
    assert.equal(
      synchronizeSettingsMenuExpansion({
        expanded: true,
        wasSettingsPath: true,
        settingsPath: false,
      }),
      false
    );
  });

  it('keeps an expanded submenu open between Settings pages', () => {
    assert.equal(
      synchronizeSettingsMenuExpansion({
        expanded: true,
        wasSettingsPath: true,
        settingsPath: true,
      }),
      true
    );
  });

  it('preserves a manual collapse between Settings pages', () => {
    assert.equal(
      synchronizeSettingsMenuExpansion({
        expanded: false,
        wasSettingsPath: true,
        settingsPath: true,
      }),
      false
    );
  });
});
