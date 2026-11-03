import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const radarr = readFileSync(
  path.join(__dirname, 'RadarrModal/index.tsx'),
  'utf8'
);
const sonarr = readFileSync(
  path.join(__dirname, 'SonarrModal/index.tsx'),
  'utf8'
);
const colorPicker = readFileSync(
  path.join(__dirname, 'ServarrRootColorPicker.tsx'),
  'utf8'
);

describe('Servarr root-folder Library settings', () => {
  it('renders the same optional stable-root editor for Radarr and Sonarr', () => {
    for (const source of [radarr, sonarr]) {
      assert.match(source, /rootFolderNames: 'Root folder names'/);
      assert.match(source, /testResponse\.rootFolders\.map\(\(folder\)/);
      assert.match(source, /sourceRootId: folder\.id/);
      assert.match(source, /path: folder\.path/);
      assert.match(source, /displayName: rootFolderNames\[folder\.id\]/);
      assert.match(source, /isAnimation: animationRoots\[folder\.id\]/);
      assert.match(source, /color: rootFolderColors\[folder\.id\]/);
      assert.match(source, /color: rootFolderColors\[folder\.id\] \?\? null/);
      assert.match(source, /maxLength=\{120\}/);
      assert.match(source, /Optional display name/);
      assert.match(source, /names, colors, and Animation designations/);
      assert.match(
        source,
        /rounded-md border border-gray-700 bg-gray-800\/50 p-3/
      );
      assert.match(source, /block break-all text-sm text-gray-300/);
      assert.match(
        source,
        /sm:grid-cols-\[minmax\(0,1fr\)_auto\] sm:items-center/
      );
      assert.match(source, /className="w-full min-w-0"/);
      assert.match(source, /okButtonProps=\{\{ type: 'button' \}\}/);
    }
  });

  it('loads persisted names for the exact service being edited', () => {
    assert.match(radarr, /serviceId: radarr\?\.id/);
    assert.match(sonarr, /serviceId: sonarr\?\.id/);
    for (const source of [radarr, sonarr]) {
      assert.match(source, /folder\.displayName \?\? ''/);
      assert.match(source, /folder\.isAnimation/);
      assert.match(source, /folder\.color/);
      assert.match(source, /messages\.animation/);
      assert.match(source, /<ServarrRootColorPicker/);
      assert.match(source, /key=\{`root-folder-name-\$\{folder\.id\}`\}/);
      assert.match(source, /title=\{folder\.path\}/);
    }
  });

  it('offers the shared predefined palette and a neutral clear action', () => {
    assert.match(colorPicker, /STORAGE_ROOT_COLOR_PALETTE\.map/);
    assert.match(colorPicker, /onChange\(null\)/);
    assert.match(colorPicker, /Use default color/);
  });
});
