import { MediaStatus } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { Permission } from '@server/lib/permissions';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import * as jsxRuntime from 'react/jsx-runtime';
import { register } from 'tsconfig-paths';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';

const root = path.join(__dirname, '../../..');
const unregister = register({
  baseUrl: root,
  paths: { '@app/*': ['src/*'], '@server/*': ['server/*'] },
});
const previousTsx = require.extensions['.tsx'];
const previousTs = require.extensions['.ts']!;
const compileClient: NonNullable<typeof previousTs> = (module, filename) => {
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
require.extensions['.tsx'] = compileClient;
require.extensions['.ts'] = (module, filename) => {
  if (filename.startsWith(path.join(root, 'src') + path.sep))
    compileClient(module, filename);
  else previousTs(module, filename);
};
const previousModules = new Map<string, NodeModule | undefined>();
const stub = (name: string, exports: unknown) => {
  const filename = require.resolve(name);
  previousModules.set(filename, require.cache[filename]);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  } as NodeModule;
};
const component = (value: unknown) => ({ __esModule: true, default: value });
const empty = () => null;
const movie = {
  id: 101,
  mediaType: 'movie',
  title: 'A Movie',
  voteAverage: 7.86,
  mediaInfo: { status: MediaStatus.AVAILABLE },
  overview: 'Movie overview',
  releaseDate: '2026-01-01',
};
const series = {
  id: 202,
  mediaType: 'tv',
  name: 'A Series',
  voteAverage: 8,
  overview: 'Series overview',
  firstAirDate: '2026-01-01',
};
const items = [movie, series];
let touch = false;
let routeQuery: Record<string, string | undefined> = {};
const queryChanges: Record<string, string | undefined>[] = [];
let discoverPageKey: (
  pageIndex: number,
  previous: { totalPages: number } | null
) => string | null;
let infiniteOptions: { initialSize?: number; persistSize?: boolean };
let sortControl: {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
};
const recordSelect =
  (factory: typeof jsxRuntime.jsx): typeof jsxRuntime.jsx =>
  (...args) => {
    const [type, props] = args;
    if (
      type === 'select' &&
      (props as { 'aria-label'?: string })['aria-label'] === 'Sort Fresh media'
    )
      sortControl = props as typeof sortControl;
    return factory(...args);
  };
stub('react/jsx-runtime', {
  ...jsxRuntime,
  jsx: recordSelect(jsxRuntime.jsx),
  jsxs: recordSelect(jsxRuntime.jsxs),
});
stub('@app/assets/spinner.svg', component(empty));
stub('@app/components/RequestModal', component(empty));
stub('@app/components/BlocklistModal', component(empty));
stub('@app/components/PersonCard', component(empty));
stub('@app/components/TitleCard/TmdbTitleCard', component(empty));
stub('@app/components/Library/LibraryEngagement', { UserAvatar: empty });
stub('@app/components/Common/PageTitle', component(empty));
stub(
  '@app/components/Common/CachedImage',
  component(({ src, alt }: { src: string; alt: string }) =>
    createElement('img', { src, alt })
  )
);
stub(
  '@app/components/Slider',
  component(({ items }: { items: ReactNode[] }) =>
    createElement('section', null, items)
  )
);
stub('@app/hooks/useIsTouch', { useIsTouch: () => touch });
stub('@app/hooks/useUser', {
  Permission,
  UserType,
  useUser: () => ({
    user: { id: 1, userType: UserType.LOCAL },
    hasPermission: () => true,
  }),
});
stub(
  '@app/hooks/useToasts',
  component(() => ({
    addToast: () => assert.fail('no mutation or toast expected'),
  }))
);
stub('@app/hooks/useVerticalScroll', component(empty));
stub(
  '@app/hooks/useSettings',
  component(() => ({ currentSettings: { freshEnabled: true } }))
);
stub('@app/hooks/useUpdateQueryParams', {
  useUpdateQueryParams:
    (base: Record<string, string | undefined>) =>
    (key: string, value?: string) => {
      queryChanges.push({ ...base, [key]: value });
    },
});
stub('next/router', {
  useRouter: () => ({
    query: routeQuery,
    pathname: '/fresh',
    asPath: '/fresh',
  }),
});
stub(
  'swr/infinite',
  component(
    (getKey: typeof discoverPageKey, options: typeof infiniteOptions) => {
      discoverPageKey = getKey;
      infiniteOptions = options;
      return {
        data: [{ results: items, totalPages: 1, totalResults: 2 }],
        size: 2,
        setSize: empty,
      };
    }
  )
);
after(() => {
  for (const [filename, previous] of previousModules) {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
  }
  require.extensions['.tsx'] = previousTsx;
  require.extensions['.ts'] = previousTs;
  unregister();
});
const render = (child: ReactNode, locale = 'en') =>
  renderToStaticMarkup(
    createElement(
      IntlProvider,
      {
        locale,
        messages: {
          'components.TitleCard.RatingBadge.rating':
            'TMDB rating: {rating} out of 10',
        },
      },
      child
    )
  );

describe('Fresh ratings and shared card integration', () => {
  it('renders localized sort choices and uses new page-one query keys when the selected sort changes', async () => {
    const { default: Fresh, resetFreshSortPages } = await import('./index');
    const { default: FreshSlider } = await import('../Discover/FreshSlider');
    try {
      const resets: number[] = [];
      let previous = resetFreshSortPages('freshest', 'freshest', (count) =>
        resets.push(count)
      );
      assert.equal(
        resets.length,
        0,
        'normal initial render/Back must retain cached pages'
      );
      previous = resetFreshSortPages(previous, 'vote_average', (count) =>
        resets.push(count)
      );
      previous = resetFreshSortPages(previous, 'vote_count', (count) =>
        resets.push(count)
      );
      previous = resetFreshSortPages(previous, 'vote_count', (count) =>
        resets.push(count)
      );
      resetFreshSortPages(previous, 'freshest', (count) => resets.push(count));
      assert.deepEqual(resets, [1, 1, 1]);
      for (const sort of ['freshest', 'oldest', 'vote_average', 'vote_count']) {
        routeQuery = { mediaType: 'tv', sort, page: '9' };
        const markup = render(createElement(Fresh));
        assert.match(markup, /TMDB Rating — Highest First/);
        assert.match(markup, /TMDB Votes — Most First/);
        assert.equal(sortControl.value, sort);
        assert.equal(
          discoverPageKey(0, null),
          `/api/v1/fresh?page=1&mediaType=tv&sort=${sort}`
        );
        assert.equal(
          discoverPageKey(1, { totalPages: 3 }),
          `/api/v1/fresh?page=2&mediaType=tv&sort=${sort}`
        );
        assert.equal(discoverPageKey(3, { totalPages: 3 }), null);
        assert.notEqual(
          infiniteOptions.persistSize,
          true,
          'retain the shared SWR query-change reset behavior'
        );
        sortControl.onChange({
          target: { value: 'vote_count' },
        } as React.ChangeEvent<HTMLSelectElement>);
        assert.deepEqual(queryChanges.at(-1), {
          page: undefined,
          sort: 'vote_count',
        });
        sortControl.onChange({
          target: { value: 'freshest' },
        } as React.ChangeEvent<HTMLSelectElement>);
        assert.deepEqual(queryChanges.at(-1), {
          page: undefined,
          sort: undefined,
        });
      }
      routeQuery = { sort: 'not-a-sort' };
      render(createElement(Fresh));
      assert.equal(sortControl.value, 'freshest');
      routeQuery = {};
      render(createElement(Fresh));
      assert.equal(
        discoverPageKey(0, null),
        '/api/v1/fresh?page=1&mediaType=all&sort=freshest'
      );
      render(createElement(FreshSlider));
      assert.equal(
        discoverPageKey(0, null),
        '/api/v1/fresh?page=1',
        'Discover slider retains default ordering without a new sort parameter'
      );
    } finally {
      routeQuery = {};
    }
  });
  it('reuses the media-type badge styling with compact rating-only padding and matching height', async () => {
    const { default: Badge } = await import('../TitleCard/RatingBadge');
    const { default: CornerBadge } = await import('../TitleCard/CornerBadge');
    const rating = render(createElement(Badge, { score: 7.5 }));
    for (const tone of ['movie', 'series'] as const) {
      const media = render(
        createElement(CornerBadge, { tone, children: tone })
      );
      const classes = (markup: string) =>
        markup
          .match(/class="([^"]*)"/)![1]
          .split(' ')
          .filter(
            (value) =>
              value &&
              !value.startsWith('text-') &&
              !['self-end', 'h-6', '!px-1', '!py-0.5'].includes(value)
          )
          .sort();
      assert.deepEqual(classes(rating), classes(media));
    }
    assert.match(
      rating,
      /<span class="min-w-0 truncate"><span class="block text-white"/
    );
    assert.match(rating, /h-6 self-end !px-1 !py-0\.5/);
    assert.doesNotMatch(rating, /<svg|gap-1|leading-|h-\[/);
  });
  it('formats one decimal with an accessible TMDB label and hides invalid/missing/zero ratings', async () => {
    const { default: Badge } = await import('../TitleCard/RatingBadge');
    for (const [score, label] of [
      [7.86, '7.9'],
      [8, '8.0'],
      [10, '10.0'],
    ] as const) {
      const markup = render(createElement(Badge, { score }));
      assert.match(
        markup,
        new RegExp(`TMDB rating: ${label.replace('.', '\\.')} out of 10`)
      );
      assert.match(markup, /bg-gray-900\/90/);
      assert.match(markup, /text-white/);
      assert.match(
        markup,
        new RegExp(
          `<span aria-hidden="true">${label.replace('.', '\\.')}</span>`
        )
      );
      assert.doesNotMatch(markup, /<svg/);
      assert.doesNotMatch(markup, /<button|<a\b|tabindex/i);
    }
    for (const score of [undefined, 0, -1, 11, NaN, Infinity, '7.5']) {
      assert.equal(
        render(createElement(Badge, { score: score as number })),
        ''
      );
    }
    assert.match(render(createElement(Badge, { score: 7.5 }), 'fr'), /7,5/);
  });
  it('opts in on the dedicated Fresh page and Discover Fresh slider for Movie and Series cards', async () => {
    const { default: Fresh } = await import('./index');
    const { default: FreshSlider } = await import('../Discover/FreshSlider');
    for (const Surface of [Fresh, FreshSlider]) {
      const markup = render(createElement(Surface));
      assert.equal(
        (markup.match(/data-testid="title-card-rating"/g) ?? []).length,
        2
      );
      const ratings = [
        ...markup.matchAll(
          /data-testid="title-card-rating"><span aria-hidden="true">([^<]*)<\/span><\/span>/g
        ),
      ];
      assert.equal(ratings.length, 2);
      for (const [, content] of ratings) {
        assert.match(content, /^\d+\.\d$/);
      }
      assert.match(markup, /href="\/movie\/101"/);
      assert.match(markup, /href="\/tv\/202"/);
      assert.match(markup, /View A Movie/);
      assert.match(markup, /View A Series/);
      assert.doesNotMatch(markup, /data-state-slot="availability"/);
      assert.match(markup, /role="img" aria-label="Available"/);
      assert.match(markup, /data-testid="title-card-request-region"/);
      assert.match(markup, /aria-label="Request"/);
    }
  });
  it('keeps ordinary cards, lists and sliders unchanged unless explicitly enabled', async () => {
    const { default: TitleCard } = await import('../TitleCard');
    const { default: ListView } = await import('../Common/ListView');
    const { default: MediaSlider } = await import('../MediaSlider');
    for (const child of [
      createElement(TitleCard, {
        id: 101,
        title: 'Ordinary Movie',
        mediaType: 'movie',
        userScore: 8,
      }),
      createElement(ListView, { items: items as never, onScrollBottom: empty }),
      createElement(MediaSlider, {
        title: 'Other slider',
        url: '/api/v1/discover/movies',
        sliderKey: 'other',
      }),
    ]) {
      assert.doesNotMatch(render(child), /data-testid="title-card-rating"/);
    }
  });
  it('keeps ratings noninteractive inside the corner frame on touch cards and retains request/navigation labels', async () => {
    const { default: TitleCard } = await import('../TitleCard');
    touch = true;
    try {
      for (const mediaType of ['movie', 'tv'] as const) {
        const markup = render(
          createElement(TitleCard, {
            id: 42,
            title: 'Touch title',
            mediaType,
            showRating: true,
            userScore: 7,
            watchState: 'watched',
          })
        );
        assert.match(markup, /pointer-events-none absolute inset-0 z-30 p-2/);
        assert.match(markup, /flex flex-col items-end gap-1/);
        assert.ok(
          markup.indexOf('title-card-rating') <
            markup.indexOf('title-card-action-state-grid')
        );
        assert.match(markup, /data-state-slot="watched"/);
        assert.match(markup, /aria-label="View Touch title"/);
        assert.match(markup, /focus-visible:ring-indigo-400/);
        assert.match(markup, /aria-label="Request"/);
      }
    } finally {
      touch = false;
    }
  });
});
