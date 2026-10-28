import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const acquisitionSurfaces = {
  RequestCard: 'src/components/RequestCard/index.tsx',
  RequestItem: 'src/components/RequestList/RequestItem/index.tsx',
  MovieDetails: 'src/components/MovieDetails/index.tsx',
  TvDetails: 'src/components/TvDetails/index.tsx',
};

// Execute the actual component hook call, not a copy of its polling callback.
// Both the unit fixture and the explicit browser fixture use this extraction.
export function acquisitionHookSource(
  surface: keyof typeof acquisitionSurfaces
) {
  const filename = path.join(__dirname, '../..', acquisitionSurfaces[surface]);
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const calls: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useSWR' &&
      node.arguments.some(
        (argument) =>
          ts.isObjectLiteralExpression(argument) &&
          argument.properties.some(
            (property) => property.name?.getText(source) === 'refreshInterval'
          )
      )
    )
      calls.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(calls.length, 1, `${surface} must have one acquisition poller`);
  return `function ${surface}(context) {
    const { request, movie, tv, routeMovieId, routeTvId, detailsCacheKey,
      useSWR, axios, getRequestRefreshInterval, getMediaRefreshInterval } = context;
    return ${calls[0]};
  }`;
}
