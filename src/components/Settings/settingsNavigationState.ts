export const isSettingsPath = (pathname: string): boolean =>
  /^\/settings(?:\/|$)/.test(pathname);

export const synchronizeSettingsMenuExpansion = ({
  expanded,
  wasSettingsPath,
  settingsPath,
}: {
  expanded: boolean;
  wasSettingsPath: boolean;
  settingsPath: boolean;
}): boolean => (wasSettingsPath === settingsPath ? expanded : settingsPath);
