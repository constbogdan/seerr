export const normalizeFreshTitle = (title: string): string =>
  title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const validReleaseId = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
