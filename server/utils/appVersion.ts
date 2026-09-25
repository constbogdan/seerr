import logger from '@server/logger';
import { existsSync } from 'fs';
import path from 'path';

const COMMIT_TAG_PATH = path.join(__dirname, '../../committag.json');
const BUILD_METADATA_PATH = path.join(__dirname, '../../buildmetadata.json');
let commitTag = 'local';

export type BuildChannel = 'official' | 'develop' | 'downstream' | 'local';

type BuildMetadata = {
  channel?: unknown;
  version?: unknown;
  commitTag?: unknown;
};

if (existsSync(COMMIT_TAG_PATH)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  commitTag = require(COMMIT_TAG_PATH).commitTag;
  logger.info(`Commit Tag: ${commitTag}`);
}

export const getCommitTag = (): string => {
  return commitTag;
};

const loadBuildMetadata = (): BuildMetadata | undefined => {
  if (!existsSync(BUILD_METADATA_PATH)) {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(BUILD_METADATA_PATH);
};

export const getDownstreamVersion = (
  metadata: BuildMetadata | undefined = loadBuildMetadata(),
  currentCommitTag = getCommitTag()
): string | undefined => {
  if (
    metadata?.channel === 'downstream' &&
    typeof metadata.version === 'string' &&
    /^custom-v1\.0\.[1-9][0-9]*$/.test(metadata.version) &&
    typeof metadata.commitTag === 'string' &&
    /^[0-9a-f]{40}$/.test(metadata.commitTag) &&
    metadata.commitTag === currentCommitTag
  ) {
    return metadata.version;
  }

  return undefined;
};

export const getAppVersion = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../../package.json');

  const downstreamVersion = getDownstreamVersion();
  if (downstreamVersion) {
    return downstreamVersion;
  }

  let finalVersion = version;

  if (version === '0.1.0') {
    finalVersion = `develop-${getCommitTag()}`;
  }

  return finalVersion;
};

export const getBuildChannel = (
  version = getAppVersion(),
  currentCommitTag = getCommitTag(),
  downstreamVersion = getDownstreamVersion()
): BuildChannel => {
  if (downstreamVersion) {
    return 'downstream';
  }
  if (currentCommitTag === 'local') {
    return 'local';
  }
  return version.startsWith('develop-') ? 'develop' : 'official';
};

export const shouldCheckUpstreamVersion = (
  channel = getBuildChannel()
): boolean => channel !== 'downstream';
