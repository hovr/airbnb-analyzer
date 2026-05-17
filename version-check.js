const LATEST_MANIFEST_URL = 'https://raw.githubusercontent.com/hovr/airbnb-analyzer/main/manifest.json';
const RELEASES_URL = 'https://github.com/hovr/airbnb-analyzer';

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

const checkForNewerVersion = async (versionNotice) => {
  if (!versionNotice) {
    return;
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
    const currentVersion = chrome.runtime.getManifest().version;
    const latestVersion = remoteManifest?.version;

    if (latestVersion && compareVersions(currentVersion, latestVersion) > 0) {
      versionNotice.textContent = '';
      versionNotice.append(
        `New version available: ${latestVersion}. You are using ${currentVersion}. `
      );
      const updateLink = document.createElement('a');
      updateLink.href = RELEASES_URL;
      updateLink.target = '_blank';
      updateLink.rel = 'noopener noreferrer';
      updateLink.textContent = 'View update';
      versionNotice.append(updateLink);
      versionNotice.style.display = 'block';
    }
  } catch (error) {
    console.debug('Version check skipped:', error?.message || error);
  }
};
