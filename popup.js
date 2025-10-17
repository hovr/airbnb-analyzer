document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = document.getElementById('startBtn');
  const copyBtn = document.getElementById('copyBtn');
  const status = document.getElementById('status');
  const propertyCount = document.getElementById('propertyCount');

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
    'lastExtractionTotal'
  ]);

  const updatePropertyCountDisplay = (count) => {
    if (typeof count === 'number') {
      propertyCount.textContent = `Found ${count} properties in wishlist`;
    } else {
      propertyCount.textContent = '';
    }
  };

  const updateCompletionState = (totalProcessed) => {
    if (typeof totalProcessed !== 'number' || totalProcessed <= 0) {
      return;
    }
    status.textContent = `Analysis complete! Processed ${totalProcessed} properties.`;
    status.className = 'success';
    copyBtn.style.display = 'block';
  };

  if (state.extractionInProgress) {
    startBtn.disabled = true;
    status.innerHTML = `Processing property ${state.currentProperty} of ${state.totalProperties}...`;
    status.className = 'info progress';
  } else if (state.analysisPrompt && state.lastExtractionTotal > 0) {
    updateCompletionState(state.lastExtractionTotal);
  }

  if (typeof state.propertyCount === 'number') {
    updatePropertyCountDisplay(state.propertyCount);
  }

  const refreshWishlistInfo = async () => {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getWishlistInfo' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        if (response && response.status === 'ok') {
          updatePropertyCountDisplay(response.propertyCount);
          resolve(response);
        } else {
          resolve(null);
        }
      });
    });
  };

  await refreshWishlistInfo();

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    resetStatus();
    status.textContent = 'Starting analysis...';
    status.className = 'info';

    try {
      chrome.tabs.sendMessage(tab.id, { action: 'startExtraction' }, () => {
        if (chrome.runtime.lastError) {
          status.textContent = 'Error: ' + chrome.runtime.lastError.message;
          status.className = 'error';
          startBtn.disabled = false;
        }
      });

      chrome.runtime.onMessage.addListener(function listener(message) {
        if (message.action === 'progress') {
          status.innerHTML = `Processing properties ${message.current} of ${message.total}...`;
          status.className = 'info progress';
        } else if (message.action === 'complete') {
          updateCompletionState(message.total);
          startBtn.disabled = false;
          chrome.runtime.onMessage.removeListener(listener);
          refreshWishlistInfo();
        } else if (message.action === 'error') {
          status.textContent = 'Error: ' + message.error;
          status.className = 'error';
          startBtn.disabled = false;
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
});