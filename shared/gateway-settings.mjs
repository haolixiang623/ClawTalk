function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function shouldResetDeviceToken(previousSettings = {}, nextSettings = {}) {
  return (
    normalizeString(previousSettings.gatewayUrl) !== normalizeString(nextSettings.gatewayUrl) ||
    normalizeString(previousSettings.gatewayToken) !== normalizeString(nextSettings.gatewayToken)
  );
}

export function mergeSettingsForSave(previousSettings = {}, nextSettings = {}) {
  const nextDeviceToken = normalizeString(nextSettings.deviceToken);
  const previousDeviceToken = normalizeString(previousSettings.deviceToken);

  return {
    ...nextSettings,
    deviceToken: shouldResetDeviceToken(previousSettings, nextSettings)
      ? ""
      : (nextDeviceToken || previousDeviceToken),
  };
}
