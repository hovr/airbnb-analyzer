document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = document.getElementById('startBtn');
  const copyBtn = document.getElementById('copyBtn');
  const status = document.getElementById('status');
  const propertyCount = document.getElementById('propertyCount');
  const resetContainer = document.getElementById('resetLink');
  const resetLink = document.getElementById('resetState');
  const currentWishlistPropertyIds = new Set();

  const resetStatus = () => {
    status.textContent = '';
    status.className = '';
    copyBtn.style.display = 'none';
  };

  resetStatus();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('/wishlists/')) {
    status.textContent = 'Please navigate to an Airbnb wishlist page first.';
    status.className = 'error';
    startBtn.disabled = true;
    return;
  }

  const state = await chrome.storage.local.get([
    'extractionInProgress',
    'currentProperty',
    'totalProperties',
    'propertyCount',
    'analysisPrompt',
    'lastExtractionTotal',
    'activePropertyIndices',
    'completedPropertyCount'
  ]);

  const shouldShowReset = (stateObj) => {
    if (!stateObj) {
      return false;
    }
    return Boolean(
      stateObj.extractionInProgress ||
      (typeof stateObj.completedPropertyCount === 'number' && stateObj.completedPropertyCount > 0) ||
      (typeof stateObj.totalProperties === 'number' && stateObj.totalProperties > 0) ||
      stateObj.analysisPrompt ||
      (typeof stateObj.lastExtractionTotal === 'number' && stateObj.lastExtractionTotal > 0)
    );
  };

  const updateResetVisibility = (stateObj) => {
    if (!resetContainer) {
      return;
    }
    resetContainer.style.display = shouldShowReset(stateObj) ? 'block' : 'none';
  };

  updateResetVisibility(state);

  const updatePropertyCountDisplay = (count) => {
    if (typeof count === 'number') {
      propertyCount.textContent = `Found ${count} properties in wishlist`;
    } else {
      propertyCount.textContent = '';
    }
  };

  const getPropertyIdFromUrl = (url) => {
    if (!url) {
      return null;
    }
    const match = url.match(/\/rooms\/(\d+)/);
    return match ? match[1] : null;
  };

  const updatePropertyIds = (links) => {
    currentWishlistPropertyIds.clear();
    if (!Array.isArray(links)) {
      return;
    }
    links.forEach((link) => {
      const propertyId = getPropertyIdFromUrl(link?.url);
      if (propertyId) {
        currentWishlistPropertyIds.add(propertyId);
      }
    });
  };

  const updateCompletionState = (totalProcessed) => {
    if (typeof totalProcessed !== 'number' || totalProcessed <= 0) {
      return;
    }
    status.textContent = `Analysis complete! Processed ${totalProcessed} properties.`;
    status.className = 'success';
    copyBtn.style.display = 'block';
  };

  const formatActiveList = (completed, activeList, total) => {
    if (activeList && activeList.length) {
      const text = activeList.join(', ');
      return `${text} of ${total}`;
    }
    if (total) {
      const next = Math.min(completed + 1, total);
      return `${next} of ${total}`;
    }
    return '';
  };

  if (state.extractionInProgress) {
    startBtn.disabled = true;
    const activeText = formatActiveList(state.completedPropertyCount || 0, state.activePropertyIndices || [], state.totalProperties || state.propertyCount || 0);
    if (activeText) {
      status.innerHTML = `Processing properties ${activeText}...`;
    } else {
      status.innerHTML = `Processing properties...`;
    }
    status.className = 'info progress';
    updateResetVisibility({ extractionInProgress: true });
  } else if (state.analysisPrompt && state.lastExtractionTotal > 0) {
    updateCompletionState(state.lastExtractionTotal);
  }

  if (typeof state.propertyCount === 'number') {
    updatePropertyCountDisplay(state.propertyCount);
  }

  const refreshWishlistInfo = async (options = {}) => {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getWishlistInfo', includePropertyLinks: Boolean(options?.includeLinks) }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        if (response && response.status === 'ok') {
          updatePropertyCountDisplay(response.propertyCount);
          if (options?.includeLinks && response.propertyLinks) {
            updatePropertyIds(response.propertyLinks);
          }
          resolve(response);
        } else {
          resolve(null);
        }
      });
    });
  };

  await refreshWishlistInfo({ includeLinks: true });

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    resetStatus();
    status.textContent = 'Starting analysis...';
    status.className = 'info';

    try {
      chrome.tabs.sendMessage(tab.id, { action: 'startExtraction' }, (response) => {
        if (chrome.runtime.lastError) {
          status.textContent = 'Error: ' + chrome.runtime.lastError.message;
          status.className = 'error';
          startBtn.disabled = false;
          return;
        }

        if (!response) {
          status.textContent = 'Error: no response from content script.';
          status.className = 'error';
          startBtn.disabled = false;
        } else if (response.status === 'busy') {
          status.textContent = 'Analysis already in progress. Please wait for it to finish.';
          status.className = 'error';
          startBtn.disabled = false;
        }
      });

      chrome.runtime.onMessage.addListener(function listener(message) {
        if (message.action === 'progress') {
          const infoText = message.current ? `Processing properties ${message.current} of ${message.total}...` : `Processing properties...`;
          status.innerHTML = infoText;
          status.className = 'info progress';
        } else if (message.action === 'complete') {
          updateCompletionState(message.total);
          startBtn.disabled = false;
          updateResetVisibility({ analysisPrompt: true, lastExtractionTotal: message.total });
          chrome.runtime.onMessage.removeListener(listener);
          refreshWishlistInfo({ includeLinks: true });
        } else if (message.action === 'error') {
          status.textContent = message.error ? `Error: ${message.error}` : 'Error during analysis.';
          status.className = message.error === 'Analysis cancelled' ? 'info' : 'error';
          startBtn.disabled = false;
          updateResetVisibility({});
          chrome.runtime.onMessage.removeListener(listener);
        }
      });
    } catch (error) {
      status.textContent = 'Error: ' + error.message;
      status.className = 'error';
      startBtn.disabled = false;
    }
  });

  copyBtn.addEventListener('click', async () => {
    try {
      const result = await chrome.storage.local.get(['analysisPrompt']);
      if (result.analysisPrompt) {
        await navigator.clipboard.writeText(result.analysisPrompt);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy Prompt';
        }, 2000);
      }
    } catch (error) {
      status.textContent = 'Error copying: ' + error.message;
      status.className = 'error';
    }
  });

  resetLink.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await refreshWishlistInfo({ includeLinks: true });
      const propertyIds = Array.from(currentWishlistPropertyIds);
      let cacheFlushed = false;

      if (propertyIds.length > 0) {
        const storedCache = await chrome.storage.local.get('propertyCache');
        const cacheEntries = storedCache?.propertyCache || {};
        const hasMatches = propertyIds.some((id) => cacheEntries[id]);

        if (hasMatches) {
          const shouldFlush = window.confirm('Cached property data for this wishlist was found. Do you want to flush it?');
          if (shouldFlush) {
            const flushResponse = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage({ action: 'flushPropertyCache', propertyIds }, (response) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                  return;
                }
                resolve(response);
              });
            });

            if (flushResponse?.status === 'error') {
              throw new Error(flushResponse.error || 'Failed to flush cache');
            }
            cacheFlushed = flushResponse?.status === 'flushed';
          }
        }
      }

      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'resetExtractionState' }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.status === 'reset') {
            resolve();
          } else {
            reject(new Error('Failed to reset state'));
          }
        });
      });

      await chrome.storage.local.set({
        extractionInProgress: false,
        currentProperty: 0,
        totalProperties: 0,
        lastExtractionTotal: 0,
        analysisPrompt: null
      });

      startBtn.disabled = false;
      resetStatus();
      status.textContent = cacheFlushed ? 'Analyzer reset and cache cleared.' : 'Analyzer reset.';
      status.className = 'info';
      updateResetVisibility({});
    } catch (error) {
      status.textContent = 'Error resetting: ' + error.message;
      status.className = 'error';
    }
  });
});