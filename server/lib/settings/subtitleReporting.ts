// Reuse the existing external URL for links and derive only its HTTPS origin
// for CORS. Paths remain valid for path-based Jellyfin installations.
export function getSubtitleReportingOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !/^https:\/\//i.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127 ||
        character === '\\'
    )
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function isValidSubtitleReportingSettings(settings: {
  subtitleReportingEnabled?: unknown;
  externalHostname?: unknown;
}): boolean {
  return (
    (settings.subtitleReportingEnabled === undefined ||
      typeof settings.subtitleReportingEnabled === 'boolean') &&
    (settings.subtitleReportingEnabled !== true ||
      getSubtitleReportingOrigin(settings.externalHostname) !== null)
  );
}
