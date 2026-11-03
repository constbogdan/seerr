import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { register } from 'tsconfig-paths';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';

const unregister = register({
  baseUrl: path.join(__dirname, '../../..'),
  paths: { '@app/*': ['src/*'], '@server/*': ['server/*'] },
});
const previous = require.extensions['.tsx'];
require.extensions['.tsx'] = (module, filename) => {
  const compiled = transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      jsx: JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  (
    module as NodeModule & {
      _compile: (source: string, filename: string) => void;
    }
  )._compile(compiled.outputText, filename);
};
after(() => {
  require.extensions['.tsx'] = previous;
  unregister();
});

async function render(
  enabled?: boolean,
  externalUrl = 'https://jellyfin.test:8443/web',
  disabled = false
) {
  const { default: Section } = await import('./SubtitleReportingSettings');
  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: 'en' },
      createElement(Section, {
        enabled,
        externalUrl,
        disabled,
        onChange: () => undefined,
      })
    )
  );
}

describe('Jellyfin subtitle reporting settings section', () => {
  it('renders default-disabled and enabled states using the existing accessible toggle', async () => {
    const off = await render();
    assert.match(off, /Subtitle Issue Reporting/);
    assert.match(
      off,
      /role="checkbox"[^>]*aria-checked="false"[^>]*aria-label="Enable Subtitle Reporting"/
    );
    assert.match(await render(true), /aria-checked="true"/);
    assert.match(
      await render(true, undefined, true),
      /tabindex="-1"[^>]*aria-disabled="true"/
    );
  });

  it('shows the exact derived origin, retains standard layout and introduces no second persisted connection or secret field', async () => {
    const html = await render(true);
    assert.match(
      html,
      /for="subtitle-reporting-origin" class="text-label">Jellyfin Web Origin/
    );
    assert.match(html, /readOnly=""[^>]*value="https:\/\/jellyfin.test:8443"/);
    assert.match(html, /form-row/);
    assert.match(html, /form-input-area/);
    assert.doesNotMatch(html, /<input[^>]*name=/);
    assert.doesNotMatch(html, /password|apiKey|api-key|Seerr API key/);
  });

  it('never renders credentials, queries or unsafe URLs into the derived field', async () => {
    for (const url of [
      '',
      'http://jellyfin.test',
      'https://name:secret@jellyfin.test',
      'https://jellyfin.test?token=secret',
    ]) {
      const html = await render(false, url);
      assert.match(html, /placeholder="Not configured"/);
      assert.doesNotMatch(html, /secret|value="https:/);
    }
  });

  it('keeps integration controls in the existing Jellyfin form submission and out of setup/Emby presentation', () => {
    const source = readFileSync(
      path.join(__dirname, 'SettingsJellyfin.tsx'),
      'utf8'
    );
    assert.match(
      source,
      /subtitleReportingEnabled: data\?\.subtitleReportingEnabled \?\? false/
    );
    assert.match(
      source,
      /subtitleReportingEnabled: values\.subtitleReportingEnabled/
    );
    assert.match(
      source,
      /!isSetupSettings &&[\s\S]*MediaServerType\.JELLYFIN && \([\s\S]*<SubtitleReportingSettings/
    );
    assert.match(source, /getSubtitleReportingOrigin\(value\)/);
  });
});
