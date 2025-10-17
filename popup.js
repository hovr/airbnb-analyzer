document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = document.getElementById('startBtn');
  const copyBtn = document.getElementById('copyBtn');
  const status = document.getElementById('status');
  const propertyCount = document.getElementById('propertyCount');

  // Check if we're on a wishlist page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab.url.includes('/wishlists/')) {
    status.textContent = 'Please navigate to an Airbnb wishlist page first.';
    status.className = 'error';
    startBtn.disabled = true;
    return;
  }

  // Check if extraction is already in progress
  const state = await chrome.storage.local.get(['extractionInProgress', 'currentProperty', 'totalProperties', 'propertyCount', 'analysisPrompt']);
  
  if (state.extractionInProgress) {
    // Show current progress
    startBtn.disabled = true;
    status.innerHTML = `Processing property ${state.currentProperty} of ${state.totalProperties}...`;
    status.className = 'info progress';
  } else if (state.analysisPrompt) {
    // Analysis is complete, show copy button
    status.textContent = `Analysis complete! Processed ${state.totalProperties} properties.`;
    status.className = 'success';
    copyBtn.style.display = 'block';
  }
  
  // Get property count from storage if available
  if (state.propertyCount) {
    propertyCount.textContent = `Found ${state.propertyCount} properties in wishlist`;
  }

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    status.textContent = 'Starting analysis...';
    status.className = 'info';
    copyBtn.style.display = 'none';

    try {
      // Send message to content script to start extraction
      chrome.tabs.sendMessage(tab.id, { action: 'startExtraction' }, (response) => {
        if (chrome.runtime.lastError) {
          status.textContent = 'Error: ' + chrome.runtime.lastError.message;
          status.className = 'error';
          startBtn.disabled = false;
        }
      });

      // Listen for progress updates
      chrome.runtime.onMessage.addListener(function listener(message) {
        if (message.action === 'progress') {
          // message.current can now be a string like "10, 11, 12" or just a number
          status.innerHTML = `Processing properties ${message.current} of ${message.total}...`;
          status.className = 'info progress';
        } else if (message.action === 'complete') {
          status.textContent = `Analysis complete! Processed ${message.total} properties.`;
          status.className = 'success';
          copyBtn.style.display = 'block';
          startBtn.disabled = false;
          chrome.runtime.onMessage.removeListener(listener);
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