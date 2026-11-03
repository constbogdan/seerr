import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const navigation = readFileSync(
  path.join(__dirname, 'navigationConfig.ts'),
  'utf8'
);
const navigationPresentation = readFileSync(
  path.join(__dirname, 'navigation.tsx'),
  'utf8'
);

const assertLibraryOrder = (source: string) => {
  const requests = source.indexOf("href: '/requests'");
  const library = source.indexOf("href: '/library'");
  const collections = source.indexOf("href: '/collections'");
  const blocklist = source.indexOf("href: '/blocklist'");
  assert.ok(requests >= 0);
  assert.ok(library > requests);
  assert.ok(collections > library);
  assert.ok(blocklist > collections);
};

describe('Library navigation placement', () => {
  it('places the admin-only Library and Collections destinations before Blocklist', () => {
    assertLibraryOrder(navigation);
    assert.match(
      navigation,
      /id: 'library',[\s\S]*?href: '\/library',[\s\S]*?requiredPermission: Permission\.ADMIN/
    );
    assert.match(
      navigationPresentation,
      /library: \{[\s\S]*?icon: FolderOpenIcon,[\s\S]*?selectedIcon: FilledFolderOpenIcon,[\s\S]*?sidebarIcon: FilledFolderOpenIcon/
    );
    assert.match(
      navigation,
      /id: 'collections',[\s\S]*?href: '\/collections',[\s\S]*?requiredPermission: Permission\.ADMIN/
    );
  });
});
