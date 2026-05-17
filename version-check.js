const LATEST_MANIFEST_URL = 'https://raw.githubusercontent.com/hovr/airbnb-analyzer/main/manifest.json';
const RELEASES_URL = 'https://github.com/hovr/airbnb-analyzer';
const VERSION_UPDATE_STATUS_KEY = 'versionUpdateStatus';

const compareVersions = (currentVersion, latestVersion) => {
  const currentParts = String(currentVersion || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const latestParts = String(latestVersion || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(currentParts.length, latestParts.length);

  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] || 0;
    const latestPart = latestParts[index] || 0;
    if (latestPart > currentPart) {
      return 1;
    }
    if (latestPart < currentPart) {
      return -1;
    }
  }

  return 0;
};

const renderVersionNotice = (versionNotice, status) => {
  if (!versionNotice || !status?.hasUpdate) {
    if (versionNotice) {
      versionNotice.style.display = 'none';
    }
    return;
  }

  versionNotice.textContent = '';
  versionNotice.append(
    `New version available: ${status.latestVersion}. You are using ${status.currentVersion}. `
  );
  const updateLink = document.createElement('a');
  updateLink.href = status.releasesUrl || RELEASES_URL;
  updateLink.target = '_blank';
  updateLink.rel = 'noopener noreferrer';
  updateLink.textContent = 'View update';
  versionNotice.append(updateLink);
  versionNotice.style.display = 'block';
};

const notifyBackgroundVersionStatus = (hasUpdate) => {
  try {
    const sendPromise = chrome.runtime.sendMessage({ action: 'versionUpdateStatusChanged', hasUpdate });
    sendPromise?.catch?.(() => {});
  } catch (error) {
    console.debug('Could not notify background of version status:', error?.message || error);
  }
};

const checkForNewerVersion = async (versionNotice) => {
  if (!versionNotice) {
    return;
  }

  const currentVersion = chrome.runtime.getManifest().version;

  try {
    const stored = await chrome.storage.local.get(VERSION_UPDATE_STATUS_KEY);
    const storedStatus = stored?.[VERSION_UPDATE_STATUS_KEY];
    if (storedStatus?.currentVersion === currentVersion) {
      renderVersionNotice(versionNotice, storedStatus);
    }
  } catch (error) {
    console.debug('Stored version status unavailable:', error?.message || error);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    let response;
    try {
      response = await fetch(`${LATEST_MANIFEST_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return;
    }

    const remoteManifest = await response.json();
    const latestVersion = remoteManifest?.version || '';
    const hasUpdate = Boolean(latestVersion && compareVersions(currentVersion, latestVersion) > 0);
    const status = {
      hasUpdate,
      latestVersion,
      currentVersion,
      releasesUrl: RELEASES_URL,
      checkedAt: Date.now()
    };

    await chrome.storage.local.set({ [VERSION_UPDATE_STATUS_KEY]: status });
    renderVersionNotice(versionNotice, status);
    notifyBackgroundVersionStatus(hasUpdate);
  } catch (error) {
    console.debug('Version check skipped:', error?.message || error);
  }
};
