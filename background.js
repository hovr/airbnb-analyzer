let currentExtractionContext = null;

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
let propertyCacheStore = null;
let propertyCacheDirty = false;

const ACTIVE_ICON_PATHS = {
  16: 'icon16.png',
  48: 'icon48.png',
  128: 'icon128.png'
};

let inactiveIconDataCache = null;
let inactiveIconDataPromise = null;
let lastActionWasWishlist = null;

const cloneData = (value) => {
  if (value === undefined || value === null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.debug('Failed to clone data, returning original reference');
    return value;
  }
};

const normalizeReviewCountValue = (value) => {
  if (value === undefined || value === null) {
    return null;
  }
  const digits = String(value).replace(/[^0-9]/g, '');
  if (!digits) {
    return null;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const loadPropertyCache = async () => {
  if (propertyCacheStore) {
    return propertyCacheStore;
  }
  try {
    const stored = await chrome.storage.local.get('propertyCache');
    propertyCacheStore = stored.propertyCache || {};
  } catch (error) {
    console.debug('Failed to load property cache', error);
    propertyCacheStore = {};
  }
  return propertyCacheStore;
};

const markCacheDirty = () => {
  propertyCacheDirty = true;
};

const persistPropertyCacheIfDirty = async () => {
  if (!propertyCacheDirty || !propertyCacheStore) {
    return;
  }
  try {
    await chrome.storage.local.set({ propertyCache: propertyCacheStore });
    propertyCacheDirty = false;
  } catch (error) {
    console.error('Failed to persist property cache:', error);
  }
};

const getPropertyIdFromUrl = (url) => {
  if (!url) {
    return null;
  }
  const match = url.match(/\/rooms\/(\d+)/);
  return match ? match[1] : null;
};

const cleanupExpiredCache = async (now = Date.now()) => {
  const cache = await loadPropertyCache();
  let removed = false;
  Object.entries(cache).forEach(([key, entry]) => {
    if (!entry || !entry.cachedAt || (now - entry.cachedAt) > CACHE_TTL_MS) {
      delete cache[key];
      removed = true;
    }
  });
  if (removed) {
    markCacheDirty();
  }
};

const getCachedPropertyData = (propertyId, normalizedReviewCount, now = Date.now()) => {
  if (!propertyId) {
    return null;
  }
  if (!propertyCacheStore) {
    return null;
  }
  const entry = propertyCacheStore[propertyId];
  if (!entry || !entry.cachedAt || (now - entry.cachedAt) > CACHE_TTL_MS) {
    return null;
  }
  const cachedCount = entry.wishlistReviewCount ?? null;
  const targetCount = normalizedReviewCount ?? null;
  if (cachedCount !== targetCount) {
    return null;
  }
  if (!entry.data) {
    return null;
  }
  return cloneData(entry.data);
};

const cachePropertyData = (propertyId, normalizedReviewCount, data, now = Date.now()) => {
  if (!propertyId || !data) {
    return;
  }
  if (!propertyCacheStore) {
    propertyCacheStore = {};
  }
  propertyCacheStore[propertyId] = {
    cachedAt: now,
    wishlistReviewCount: normalizedReviewCount ?? null,
    data: cloneData(data)
  };
  markCacheDirty();
};

function registerContextTab(context, tabId) {
  if (!context || !tabId) {
    return;
  }
  context.tabs.add(tabId);
}

function unregisterContextTab(context, tabId) {
  if (!context || !tabId) {
    return;
  }
  context.tabs.delete(tabId);
}

async function closeTabSafe(tabId) {
  if (!tabId) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    if (error && error.message && error.message.includes('No tab')) {
      return;
    }
    console.debug('closeTabSafe ignored', error?.message || error);
  }
}

async function cancelActiveExtraction() {
  const context = currentExtractionContext;
  if (!context) {
    return false;
  }
  if (context.cancelled) {
    return false;
  }
  context.cancelled = true;
  const tabIds = Array.from(context.tabs.values());
  await Promise.all(tabIds.map((tabId) => closeTabSafe(tabId)));
  return true;
}

async function resetExtractionState(options = {}) {
  if (!options.skipCancel) {
    await cancelActiveExtraction();
  }
  await chrome.storage.local.set({
    extractionInProgress: false,
    currentProperty: 0,
    totalProperties: 0,
    lastExtractionTotal: 0,
    analysisPrompt: null,
    propertyCount: 0,
    activePropertyIndices: [],
    completedPropertyCount: 0
  });
}

async function flushPropertyCacheForIds(propertyIds = []) {
  if (!propertyIds || propertyIds.length === 0) {
    return false;
  }

  await loadPropertyCache();
  if (!propertyCacheStore || Object.keys(propertyCacheStore).length === 0) {
    return false;
  }

  let removed = false;
  propertyIds.forEach((propertyId) => {
    if (!propertyId || !propertyCacheStore[propertyId]) {
      return;
    }
    delete propertyCacheStore[propertyId];
    removed = true;
  });

  if (!removed) {
    return false;
  }

  markCacheDirty();
  await persistPropertyCacheIfDirty();
  return true;
}

const isWishlistUrl = (url) => {
  if (typeof url !== 'string') {
    return false;
  }
  return /^https:\/\/www\.airbnb\.(?:co\.uk|com)\/wishlists\//i.test(url);
};

const isRoomUrl = (url) => {
  if (typeof url !== 'string') {
    return false;
  }
  return /^https:\/\/www\.airbnb\.(?:co\.uk|com)\/rooms\/\d+/i.test(url);
};

const convertIconToGrayscale = async (path) => {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return null;
  }

  const url = chrome.runtime.getURL(path);
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;

    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
    }

    return imageData;
  } finally {
    bitmap.close?.();
  }
};

const loadInactiveIconData = async () => {
  if (inactiveIconDataCache) {
    return inactiveIconDataCache;
  }
  if (inactiveIconDataPromise) {
    return inactiveIconDataPromise;
  }

  inactiveIconDataPromise = (async () => {
    const entries = await Promise.all(
      Object.entries(ACTIVE_ICON_PATHS).map(async ([size, path]) => {
        const grayscaleData = await convertIconToGrayscale(path);
        return [size, grayscaleData];
      })
    );
    inactiveIconDataCache = entries.reduce((acc, [size, imageData]) => {
      if (imageData) {
        acc[size] = imageData;
      }
      return acc;
    }, {});
    return inactiveIconDataCache;
  })();

  try {
    return await inactiveIconDataPromise;
  } finally {
    inactiveIconDataPromise = null;
  }
};

const setActionState = async (isWishlistActive) => {
  const targetState = Boolean(isWishlistActive);
  if (lastActionWasWishlist === targetState) {
    return;
  }

  try {
    if (targetState) {
      await chrome.action.setPopup({ popup: 'popup.html' });
      await chrome.action.setIcon({ path: ACTIVE_ICON_PATHS });
    } else {
      await chrome.action.setPopup({ popup: 'inactive.html' });
      const iconData = await loadInactiveIconData();
      if (iconData && Object.keys(iconData).length) {
        await chrome.action.setIcon({ imageData: iconData });
      } else {
        await chrome.action.setIcon({ path: ACTIVE_ICON_PATHS });
      }
    }
    lastActionWasWishlist = targetState;
  } catch (error) {
    console.debug('setActionState failed', error);
  }
};

const evaluateTabForAction = async (tab) => {
  if (!tab) {
    await setActionState(false);
    return;
  }
  const isWishlist = isWishlistUrl(tab.url || '');
  const isRoom = isRoomUrl(tab.url || '');
  await setActionState(isWishlist || isRoom);
};

const updateActionForTabId = async (tabId) => {
  if (!tabId) {
    await setActionState(false);
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    await evaluateTabForAction(tab);
  } catch (error) {
    console.debug('updateActionForTabId failed', error);
    await setActionState(false);
  }
};

const initializeActionState = async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await evaluateTabForAction(activeTab || null);
  } catch (error) {
    console.debug('initializeActionState failed', error);
    await setActionState(false);
  }
};
chrome.runtime.onStartup.addListener(() => {
  resetExtractionState();
  cleanupExpiredCache();
  persistPropertyCacheIfDirty();
  initializeActionState();
});

chrome.runtime.onInstalled.addListener(() => {
  initializeActionState();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!activeInfo || typeof activeInfo.tabId !== 'number') {
    setActionState(false);
    return;
  }
  updateActionForTabId(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    evaluateTabForAction(tab);
  }
});

const MIN_STAGGER_DELAY_MS = 800;
const STAGGER_DELAY_JITTER_MS = 1200;

const focusTab = async (tabId, focusWindow = false) => {
  if (!tabId) {
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (focusWindow) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    console.debug('focusTab failed', error);
  }
};

const restoreOriginFocus = async (originContext) => {
  if (!originContext || !originContext.tabId) {
    return;
  }
  try {
    await chrome.windows.update(originContext.windowId, { focused: true });
    await chrome.tabs.update(originContext.tabId, { active: true });
  } catch (error) {
    console.debug('restoreOriginFocus failed', error);
  }
};
// Background service worker to handle tab operations and data extraction

const safeSendRuntimeMessage = (payload) => {
  try {
    chrome.runtime.sendMessage(payload, () => {
      if (chrome.runtime.lastError) {
        console.debug('runtime.sendMessage ignored:', chrome.runtime.lastError.message);
      }
    });
    if (payload?.action === 'complete' || payload?.action === 'error') {
      chrome.action.openPopup().catch((err) => {
        console.debug('openPopup failed:', err?.message || err);
      });
    }
  } catch (error) {
    console.error('Failed to send runtime message:', error);
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'extractProperties') {
    // Start the extraction process
    extractAllProperties(message.propertyLinks);
    sendResponse({ status: 'started' });
    return true;
  }

  if (message.action === 'flushPropertyCache') {
    const propertyIds = Array.isArray(message.propertyIds) ? message.propertyIds : [];
    flushPropertyCacheForIds(propertyIds).then((removed) => {
      sendResponse({ status: removed ? 'flushed' : 'noop' });
    }).catch((error) => {
      console.debug('Failed to flush property cache', error);
      sendResponse({ status: 'error', error: error?.message || 'Failed to flush cache' });
    });
    return true;
  }

  if (message.action === 'resetExtractionState') {
    resetExtractionState().then((cancelled) => {
      sendResponse({ status: 'reset', cancelled });
    });
    return true;
  }

  if (message.action === 'extractSingleProperty') {
    const property = message.property || {};
    if (!property.url) {
      sendResponse({ status: 'error', error: 'Missing property URL' });
      return true;
    }
    extractSingleProperty(property).catch((error) => {
      console.debug('Failed to start single property extraction', error);
      safeSendRuntimeMessage({
        action: 'error',
        error: error?.message || 'Failed to start extraction',
        total: 1
      });
    });
    sendResponse({ status: 'started' });
    return true;
  }

  // Forward progress/complete/error messages to popup
  if (message.action === 'progress' || message.action === 'complete' || message.action === 'error') {
    // This will be received by popup.js
    return false;
  }
});

async function extractAllProperties(rawPropertyLinks) {
  const now = Date.now();
  await loadPropertyCache();
  await cleanupExpiredCache(now);
  const decoratedLinks = rawPropertyLinks.map((link) => {
    const normalizedReviewCount = normalizeReviewCountValue(link.reviewCount);
    const propertyId = getPropertyIdFromUrl(link.url);
    const cached = propertyId ? getCachedPropertyData(propertyId, normalizedReviewCount, now) : null;
    return {
      original: link,
      normalizedReviewCount,
      propertyId,
      cached,
      shouldUseCache: Boolean(cached)
    };
  });

  const propertiesData = [];
  const CONCURRENCY_LIMIT = 1;

  currentExtractionContext = {
    cancelled: false,
    tabs: new Set()
  };

  await chrome.storage.local.set({ 
    extractionInProgress: true,
    currentProperty: 0,
    totalProperties: decoratedLinks.length,
    lastExtractionTotal: 0,
    analysisPrompt: null
  });

  let nextIndex = 0;
  let completed = 0;

  let originContext = null;

  const results = new Array(decoratedLinks.length);
  const activeIndices = new Set();
  await chrome.storage.local.set({
    activePropertyIndices: [],
    completedPropertyCount: 0
  });

  const buildProgressList = () => {
    const sorted = Array.from(activeIndices).sort((a, b) => a - b);
    if (!sorted.length) {
      return `${Math.min(completed + 1, decoratedLinks.length)}`;
    }
    return sorted.map(idx => idx + 1).join(', ');
  };

  const launchNext = async () => {
    if (nextIndex >= decoratedLinks.length) {
      return;
    }

    if (currentExtractionContext?.cancelled) {
      return;
    }

    const currentIndex = nextIndex;
    nextIndex += 1;

    const linkData = decoratedLinks[currentIndex];
    activeIndices.add(currentIndex);
    const progressList = buildProgressList();

    chrome.storage.local.set({
      activePropertyIndices: Array.from(activeIndices).map(idx => idx + 1).sort((a, b) => a - b),
      completedPropertyCount: completed
    });

    safeSendRuntimeMessage({
      action: 'progress',
      current: progressList,
      total: decoratedLinks.length,
      propertyName: linkData.shouldUseCache ? `Using cached data for properties: ${progressList}` : `Processing properties: ${progressList}`
    });

    await chrome.storage.local.set({ currentProperty: currentIndex + 1 });

    try {
      if (!originContext) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab) {
            originContext = {
              tabId: activeTab.id,
              windowId: activeTab.windowId
            };
          }
        } catch (error) {
          console.debug('Failed to capture origin context', error);
        }
      }

      const originTabId = originContext ? originContext.tabId : null;
      if (originTabId) {
        await focusTab(originTabId, true);
        await sleep(250);
      }

      const staggerDelay = MIN_STAGGER_DELAY_MS + Math.random() * STAGGER_DELAY_JITTER_MS;
      await sleep(staggerDelay);

      if (linkData.shouldUseCache && linkData.cached) {
        results[currentIndex] = linkData.cached;
      } else {
        const data = await extractPropertyData(
          linkData.original.url,
          linkData.original.title,
          linkData.original.rating,
          linkData.original.reviewCount,
          currentIndex,
          decoratedLinks.length,
          linkData.normalizedReviewCount,
          linkData.propertyId
        );
        results[currentIndex] = data;
      }
    } catch (error) {
      if (currentExtractionContext?.cancelled) {
        console.debug('Extraction cancelled while processing', linkData.original?.url);
        return;
      }
      console.error(`Error extracting ${linkData.original?.url || 'unknown'}:`, error);
      results[currentIndex] = {
        url: linkData.original?.url,
        title: linkData.original?.title,
        error: 'Failed to extract data: ' + error.message
      };
    } finally {
      activeIndices.delete(currentIndex);
      completed += 1;

      const updatedList = buildProgressList();
      chrome.storage.local.set({
        activePropertyIndices: Array.from(activeIndices).map(idx => idx + 1).sort((a, b) => a - b),
        completedPropertyCount: completed
      });
      safeSendRuntimeMessage({
        action: 'progress',
        current: updatedList,
        total: decoratedLinks.length,
        propertyName: updatedList ? `Processing properties: ${updatedList}` : 'Finalizing results'
      });

      if (currentExtractionContext?.cancelled) {
        return;
      }

      if (completed < decoratedLinks.length) {
        await launchNext();
        return;
      }

      safeSendRuntimeMessage({
        action: 'progress',
        current: `${decoratedLinks.length}`,
        total: decoratedLinks.length,
        propertyName: 'Finalizing results'
      });

      if (originContext) {
        await restoreOriginFocus(originContext);
      }
    }
  };

  const starters = Math.min(CONCURRENCY_LIMIT, decoratedLinks.length);
  const running = [];
  for (let i = 0; i < starters; i += 1) {
    running.push(launchNext());
  }

  try {
    await Promise.all(running);
  } finally {
    const missingIndices = [];
    results.forEach((value, idx) => {
      if (!value) {
        missingIndices.push(idx + 1);
        const fallbackLink = decoratedLinks[idx]?.original;
        results[idx] = {
          url: fallbackLink?.url || 'unknown',
          title: fallbackLink?.title || `Property ${idx + 1}`,
          error: 'Extraction did not complete (timeout or user interruption).'
        };
      }
    });

    if (missingIndices.length) {
      console.warn('Extraction finished with incomplete entries', missingIndices);
    }
  }

  const wasCancelled = currentExtractionContext?.cancelled;

  if (!wasCancelled) {
    propertiesData.push(...results.filter(Boolean));

    const prompt = generateLLMPrompt(propertiesData);
    
    await chrome.storage.local.set({ 
      analysisPrompt: prompt,
      extractionInProgress: false,
      currentProperty: 0,
      totalProperties: 0,
      lastExtractionTotal: decoratedLinks.length
    });

    safeSendRuntimeMessage({
      action: 'complete',
      total: decoratedLinks.length
    });
  } else {
    await chrome.storage.local.set({
      extractionInProgress: false,
      currentProperty: 0,
      totalProperties: 0
    });

    safeSendRuntimeMessage({
      action: 'error',
      error: 'Analysis cancelled',
      total: decoratedLinks.length
    });
  }

  currentExtractionContext = null;
  await persistPropertyCacheIfDirty();
}

async function extractSingleProperty(rawProperty) {
  const now = Date.now();
  await loadPropertyCache();
  await cleanupExpiredCache(now);

  const normalizedReviewCount = normalizeReviewCountValue(rawProperty.reviewCount);
  const propertyId = getPropertyIdFromUrl(rawProperty.url);
  const cached = propertyId ? getCachedPropertyData(propertyId, normalizedReviewCount, now) : null;

  currentExtractionContext = {
    cancelled: false,
    tabs: new Set()
  };

  await chrome.storage.local.set({
    extractionInProgress: true,
    currentProperty: 1,
    totalProperties: 1,
    lastExtractionTotal: 0,
    analysisPrompt: null,
    activePropertyIndices: [1],
    completedPropertyCount: 0
  });

  const progressLabel = cached ? 'Using cached data for property 1' : 'Processing property 1 of 1';
  safeSendRuntimeMessage({
    action: 'progress',
    current: '1',
    total: 1,
    propertyName: progressLabel
  });

  let originContext = null;
  let result = null;

  try {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        originContext = {
          tabId: activeTab.id,
          windowId: activeTab.windowId
        };
      }
    } catch (error) {
      console.debug('Failed to capture origin context for single property', error);
    }

    if (cached) {
      result = cached;
    } else {
      if (originContext?.tabId) {
        await focusTab(originContext.tabId, true);
        await sleep(200);
      }
      const staggerDelay = MIN_STAGGER_DELAY_MS + Math.random() * STAGGER_DELAY_JITTER_MS;
      await sleep(staggerDelay);

      result = await extractPropertyData(
        rawProperty.url,
        rawProperty.title,
        rawProperty.rating,
        rawProperty.reviewCount,
        0,
        1,
        normalizedReviewCount,
        propertyId
      );
    }
  } catch (error) {
    if (currentExtractionContext?.cancelled) {
      console.debug('Single property extraction cancelled');
    } else {
      console.error('Error extracting single property', error);
    }
    result = {
      url: rawProperty.url,
      title: rawProperty.title || 'Property 1',
      error: 'Failed to extract data: ' + (error?.message || 'Unknown error')
    };
  } finally {
    if (originContext) {
      await restoreOriginFocus(originContext);
    }
  }

  const wasCancelled = currentExtractionContext?.cancelled;

  if (!wasCancelled) {
    const prompt = generateSinglePropertyPrompt(result);
    await chrome.storage.local.set({
      analysisPrompt: prompt,
      extractionInProgress: false,
      currentProperty: 0,
      totalProperties: 0,
      lastExtractionTotal: 1,
      activePropertyIndices: [],
      completedPropertyCount: 1
    });

    safeSendRuntimeMessage({
      action: 'complete',
      total: 1
    });
  } else {
    await chrome.storage.local.set({
      extractionInProgress: false,
      currentProperty: 0,
      totalProperties: 0,
      activePropertyIndices: [],
      completedPropertyCount: 0
    });

    safeSendRuntimeMessage({
      action: 'error',
      error: 'Analysis cancelled',
      total: 1
    });
  }

  currentExtractionContext = null;
  await persistPropertyCacheIfDirty();
}

async function extractPropertyData(url, title, wishlistRating, wishlistReviewCount, positionIndex, totalCount, normalizedWishlistReviewCount, propertyIdOverride) {
  const propertyId = propertyIdOverride || getPropertyIdFromUrl(url);
  const cacheKeyReviewCount = normalizedWishlistReviewCount ?? normalizeReviewCountValue(wishlistReviewCount);
  const startedAt = Date.now();
  
  // First, open the main property page to get details
  const mainTab = await chrome.tabs.create({ url: url, active: true });
  registerContextTab(currentExtractionContext, mainTab.id);
  await focusTab(mainTab.id, true);
  await sleep(3500);
  
  try {
    if (currentExtractionContext?.cancelled) {
      throw new Error('Extraction cancelled');
    }

    // Extract basic info from main page
    const mainPageData = await chrome.scripting.executeScript({
      target: { tabId: mainTab.id },
      func: extractMainPageData,
      args: [title, wishlistRating, wishlistReviewCount]
    });
    
    const propertyData = mainPageData && mainPageData[0] ? mainPageData[0].result : {};
    if (propertyId && !propertyData.url) {
      propertyData.url = url;
    }
    if (title && !propertyData.title) {
      propertyData.title = title;
    }
    
    // Close main tab
    unregisterContextTab(currentExtractionContext, mainTab.id);
    await closeTabSafe(mainTab.id);
    
    // Now open reviews page if there are reviews
    if (propertyData.reviewCount && propertyData.reviewCount !== '0') {
      if (currentExtractionContext?.cancelled) {
        throw new Error('Extraction cancelled');
      }
      const reviewsUrl = `https://www.airbnb.co.uk/rooms/${propertyId}/reviews`;
      const reviewsTab = await chrome.tabs.create({ url: reviewsUrl, active: true });
      registerContextTab(currentExtractionContext, reviewsTab.id);
      await focusTab(reviewsTab.id, true);
      await sleep(4200); // Wait longer for initial load
      
      try {
        if (currentExtractionContext?.cancelled) {
          throw new Error('Extraction cancelled');
        }
        // Scroll to load ALL reviews
        const scrollResult = await chrome.scripting.executeScript({
          target: { tabId: reviewsTab.id },
          func: scrollAndLoadAllReviews,
          args: [Number.parseInt(propertyData.reviewCount, 10) || null, positionIndex + 1, totalCount]
        });
        
        const scrollInfo = scrollResult && scrollResult[0] ? scrollResult[0].result : null;
        if (scrollInfo && Number.isFinite(scrollInfo.count)) {
          propertyData.loadedReviewCount = scrollInfo.count;
          if (scrollInfo.gaveUp && scrollInfo.missing > 0) {
            propertyData.reviewShortfall = scrollInfo.missing;
          }
        }

        // Wait for reviews to load
        await sleep(3000);
        
        // Extract reviews
        const reviewsData = await chrome.scripting.executeScript({
          target: { tabId: reviewsTab.id },
          func: extractReviewsOnly
        });
        
        if (reviewsData && reviewsData[0] && reviewsData[0].result) {
          propertyData.reviews = reviewsData[0].result;
        }
        
        unregisterContextTab(currentExtractionContext, reviewsTab.id);
        await closeTabSafe(reviewsTab.id);
      } catch (error) {
        console.error('Error extracting reviews:', error);
        try {
          unregisterContextTab(currentExtractionContext, reviewsTab.id);
          await closeTabSafe(reviewsTab.id);
        } catch (e) {}
      }
    }
    
    if (propertyId && !propertyData.error) {
      cachePropertyData(propertyId, cacheKeyReviewCount, propertyData, startedAt);
    }
    return propertyData;
  } catch (error) {
    try {
      unregisterContextTab(currentExtractionContext, mainTab.id);
      await closeTabSafe(mainTab.id);
    } catch (e) {}
    throw error;
  }
}

// Extract main property info from the property page
function extractMainPageData(wishlistTitle, wishlistRating, wishlistReviewCount) {
  const data = {
    url: window.location.href,
    title: wishlistTitle || '',
    rating: wishlistRating || '',
    reviewCount: '',
    expectedReviewCount: null,
    guests: '',
    bedrooms: '',
    beds: '',
    bathrooms: '',
    description: '',
    amenities: []
  };

  try {
    const normalizeCount = (value) => {
      if (value === undefined || value === null) {
        return null;
      }
      const digits = value.toString().replace(/[^0-9]/g, '');
      if (!digits) {
        return null;
      }
      const parsed = Number.parseInt(digits, 10);
      return Number.isNaN(parsed) ? null : parsed;
    };

    const applyReviewCount = (candidate) => {
      const normalized = normalizeCount(candidate);
      if (normalized === null) {
        return false;
      }
      data.reviewCount = String(normalized);
      data.expectedReviewCount = normalized;
      return true;
    };

    if (!applyReviewCount(wishlistReviewCount) && wishlistReviewCount) {
      data.reviewCount = wishlistReviewCount;
    }

    // Only try to extract rating if we don't already have it from wishlist
    const normalizeRating = (value) => {
      if (!value && value !== 0) {
        return null;
      }
      const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value).trim());
      if (Number.isNaN(numeric) || numeric <= 0) {
        return null;
      }
      if (numeric > 5.0) {
        return null;
      }
      return numeric.toFixed(2).replace(/\.00$/, '');
    };

    const applyRating = (candidate) => {
      const normalised = normalizeRating(candidate);
      if (!normalised) {
        return false;
      }
      data.rating = normalised;
      return true;
    };

    if (!applyRating(data.rating)) {
      data.rating = '';
    }

    if (!data.rating) {
      console.log('Looking for rating on property page...');
      
      // Try to extract from property page as fallback
      const ratingLink = document.querySelector('a[href*="/reviews"]');
      if (ratingLink) {
        console.log('Found rating link:', ratingLink.textContent);
        const ratingText = ratingLink.textContent.trim();
        const isPureReviewCount = /^\s*\d{1,4}(?:,\d{3})*\s+reviews?\s*$/i.test(ratingText);
        if (!isPureReviewCount) {
          const ratingMatch = ratingText.match(/([\d.]+)/);
          if (!data.rating && ratingMatch) {
            applyRating(ratingMatch[1]);
          }
        }
        const reviewMatch = ratingText.match(/(\d{1,4}(?:,\d{3})*)\s+reviews?/i);
        if (reviewMatch) {
          applyReviewCount(reviewMatch[1]);
        }
      }
    }

    if (!data.expectedReviewCount) {
      const reviewButtons = [
        document.querySelector('button[data-testid="pdp-show-all-reviews-button"]'),
        document.querySelector('[data-testid="reviews-tab-panel"] button[data-testid="pdp-show-all-reviews-button"]'),
        document.querySelector('[data-testid="reviews-tab"] button[data-testid="pdp-show-all-reviews-button"]'),
        document.querySelector('[data-testid="rating-section"]'),
        document.querySelector('[data-section-id="REVIEWS_DEFAULT"] [data-testid="reviews-tab"]')
      ];

      let resolvedFromButtons = false;
      for (const node of reviewButtons) {
        if (!node || resolvedFromButtons) continue;
        const candidates = [
          node.textContent,
          node.getAttribute('aria-label'),
          node.getAttribute('title')
        ];

        for (const candidate of candidates) {
          if (!candidate) continue;
          const countMatch = candidate.match(/(\d{1,4}(?:,\d{3})*)\s+reviews?/i);
          if (countMatch && applyReviewCount(countMatch[1])) {
            resolvedFromButtons = true;
            break;
          }
        }
      }
    }

    if (!data.expectedReviewCount) {
      const summarySelectors = [
        '[data-section-id="REVIEWS_DEFAULT"] h2',
        '[data-section-id="REVIEWS_DEFAULT"] span',
        '[data-testid="reviews-tab-panel"] h2',
        '[data-testid="reviews-tab-panel"] span',
        '[data-testid="reviews-tab"] span',
        '[data-testid="rating-section"] span'
      ];

      const seenNodes = new Set();
      for (const selector of summarySelectors) {
        document.querySelectorAll(selector).forEach(node => {
          if (!node || seenNodes.has(node) || data.expectedReviewCount) {
            return;
          }

          seenNodes.add(node);
          const candidates = [
            node.textContent,
            node.getAttribute?.('aria-label'),
            node.getAttribute?.('title')
          ];

          for (const candidate of candidates) {
            if (!candidate) {
              continue;
            }
            const countMatch = candidate.match(/(\d{1,4}(?:,\d{3})*)\s+reviews?/i);
            if (countMatch && applyReviewCount(countMatch[1])) {
              return;
            }
          }
        });
        if (data.expectedReviewCount) {
          break;
        }
      }
    }

    if (!data.expectedReviewCount) {
      const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of ldScripts) {
        if (!script?.textContent) {
          continue;
        }
        try {
          const parsed = JSON.parse(script.textContent.trim());
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          for (const entry of entries) {
            const reviewCount = entry?.aggregateRating?.reviewCount ?? entry?.reviewCount;
            if (applyReviewCount(reviewCount)) {
              break;
            }
          }
          if (data.expectedReviewCount) {
            break;
          }
        } catch (error) {
          console.debug('Failed to parse ld+json for review count', error);
        }
      }
    }

    if (!data.expectedReviewCount) {
      const inlineReviews = document.querySelectorAll('[data-section-id="REVIEWS_DEFAULT"] [data-review-id], [data-section-id="REVIEWS_DEFAULT"] [role="listitem"]');
      if (inlineReviews.length > 0) {
        applyReviewCount(inlineReviews.length);
      }
    }

    if (!data.reviewCount && data.expectedReviewCount) {
      data.reviewCount = String(data.expectedReviewCount);
    }
    
    console.log('Using rating:', data.rating, 'Review count:', data.reviewCount);

    // Extract guest/bedroom/bed/bathroom details
    const detailsList = document.querySelector('[data-section-id="OVERVIEW_DEFAULT_V2"] ol.lgx66tx');
    if (detailsList) {
      const listItems = detailsList.querySelectorAll('li');
      listItems.forEach(li => {
        const text = li.textContent.trim();
        
        if (text.includes('guest')) {
          const match = text.match(/(\d+)\s+guest/i);
          if (match) data.guests = match[1];
        }
        if (text.includes('bedroom')) {
          const match = text.match(/(\d+)\s+bedroom/i);
          if (match) data.bedrooms = match[1];
        }
        if (text.includes('bed') && !text.includes('bedroom')) {
          const match = text.match(/(\d+)\s+bed(?!room)/i);
          if (match) data.beds = match[1];
        }
        if (text.includes('bath')) {
          const match = text.match(/(\d+(?:\.\d+)?)\s+bath/i);
          if (match) data.bathrooms = match[1];
        }
      });
    }

    // Extract full description
    const descSection = document.querySelector('[data-section-id="DESCRIPTION_DEFAULT"]');
    if (descSection) {
      const descSpans = descSection.querySelectorAll('span');
      let fullDescription = '';
      
      descSpans.forEach(span => {
        const text = span.textContent.trim();
        if (text.length > fullDescription.length && 
            !text.includes('Show more') && 
            !text.includes('Show original') &&
            !text.includes('automatically translated')) {
          fullDescription = text;
        }
      });
      
      data.description = fullDescription;
    }

    // Extract all amenities
    const amenitiesSection = document.querySelector('[data-section-id="AMENITIES_DEFAULT"]');
    if (amenitiesSection) {
      const amenityDivs = amenitiesSection.querySelectorAll('._19xnuo97');
      
      amenityDivs.forEach(div => {
        const textDiv = div.querySelector('.iikjzje > div:first-child');
        if (textDiv) {
          const amenityText = textDiv.textContent.trim();
          const isUnavailable = textDiv.querySelector('del') !== null;
          
          if (amenityText && !amenityText.includes('Show all')) {
            if (isUnavailable) {
              data.amenities.push(`❌ ${amenityText.replace('Unavailable: ', '')}`);
            } else {
              data.amenities.push(`✓ ${amenityText}`);
            }
          }
        }
      });
    }

  } catch (error) {
    console.error('Error extracting main page data:', error);
    data.error = error.message;
  }

  return data;
}

// Scroll aggressively to load ALL reviews
async function scrollAndLoadAllReviews(expectedTotal, propertyNumber = null, totalProperties = null) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const dedupe = (elements) => {
    const seen = new Set();
    const result = [];
    elements.forEach(el => {
      if (el && !seen.has(el)) {
        seen.add(el);
        result.push(el);
      }
    });
    return result;
  };

  const readTotalBadge = () => {
    const variants = [
      '[data-testid="reviews-tab"][aria-controls] span:not(:empty)',
      '[data-testid="reviews-tab-panel"] h2 span:not(:empty)',
      '[data-testid="reviews-tab-panel"] button[data-testid="pdp-show-all-reviews-button"] span:not(:empty)',
      '[data-testid="reviews-tab"] button[data-testid="pdp-show-all-reviews-button"] span:not(:empty)',
      'button[data-testid="pdp-show-all-reviews-button"] span:not(:empty)'
    ];

    for (const selector of variants) {
      const node = document.querySelector(selector);
      if (!node || node.childElementCount > 0) {
        continue;
      }
      const { textContent = '' } = node;
      if (!textContent) {
        continue;
      }
      const normalised = textContent.replace(/[^0-9]/g, '');
      if (!normalised) {
        continue;
      }
      const parsed = Number.parseInt(normalised, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  };

  const dialogReady = () => {
    const container = document.querySelector('[role="dialog"] div._17itzz4');
    if (container) {
      return container;
    }
    const standalone = document.querySelector('div._17itzz4');
    return standalone || null;
  };

  const clickCandidates = (getters) => {
    for (const getter of getters) {
      const node = getter();
      if (node && !node.disabled) {
        const text = (node.textContent || node.getAttribute('aria-label') || '').trim();
        console.log('Clicking reviews control', text);
        node.click();
        if (!expected) {
          try {
            const badgeCount = readTotalBadge();
            if (Number.isFinite(badgeCount) && badgeCount > 0) {
              expected = badgeCount;
            }
          } catch (error) {
            console.warn('Failed to read reviews badge after click', error);
          }
        }
        return true;
      }
    }
    return false;
  };

  const ensureReviewsContainerOpen = async () => {
    if (dialogReady()) {
      return true;
    }

    const openers = [
      () => document.querySelector('button[data-testid="pdp-show-all-reviews-button"]'),
      () => Array.from(document.querySelectorAll('button[aria-label]')).find(btn => {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        return aria.includes('show') && aria.includes('review');
      }),
      () => Array.from(document.querySelectorAll('button')).find(btn => {
        const text = (btn.textContent || '').toLowerCase();
        return text.includes('show all') && text.includes('review');
      }),
      () => Array.from(document.querySelectorAll('a[href*="/reviews"]')).find(link => {
        const text = (link.textContent || '').toLowerCase();
        return text.includes('review');
      })
    ];

    if (clickCandidates(openers)) {
      await wait(1400);
      if (dialogReady()) {
        return true;
      }
    }

    await wait(400);
    return Boolean(dialogReady());
  };

  const seenReviewIds = new Set();
  const seenReviewNodes = new Set();
  let expected = Number.isFinite(expectedTotal) && expectedTotal > 0 ? expectedTotal : null;
  if (!expected) {
    try {
      const badgeCount = readTotalBadge();
      if (Number.isFinite(badgeCount) && badgeCount > 0) {
        expected = badgeCount;
      }
    } catch (error) {
      console.warn('Failed to read reviews badge', error);
    }
  }

  const updateTitle = (count, suffixText) => {
    if (!propertyNumber) {
      return;
    }
    const totalLabel = expected ? expected : '?';
    const suffix = suffixText || 'reviews processed';
    const titlePrefix = totalProperties ? `#${propertyNumber}/${totalProperties}` : `#${propertyNumber}`;
    try {
      document.title = `${titlePrefix} ${count}/${totalLabel} ${suffix}`;
    } catch (error) {
      console.warn('Failed to update document title', error);
    }
  };

  const collectReviews = () => {
    const reviewNodes = document.querySelectorAll(
      '[data-review-id], [data-section-id="REVIEWS_DEFAULT"] [role="listitem"], [data-testid="reviews-tab-panel"] [role="listitem"]'
    );
    reviewNodes.forEach(node => {
      const reviewId = node.getAttribute('data-review-id') || node.id;
      if (reviewId) {
        seenReviewIds.add(reviewId);
      } else {
        seenReviewNodes.add(node);
      }
    });
    return seenReviewIds.size + seenReviewNodes.size;
  };

  const getScrollableTargets = () => {
    const targets = [];

    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const modalSpecific = dialog.querySelector('div._17itzz4');
      if (modalSpecific) {
        targets.push(modalSpecific);
      }
      targets.push(...dialog.querySelectorAll('[style*="overflow"]'));
    }

    const selectors = [
      'div._17itzz4',
      '[data-testid="reviews-tab-panel"]',
      '[data-section-id="REVIEWS_DEFAULT"]',
      '[data-testid="reviews-tab"]',
      '[data-testid="modal-container"]',
      'main'
    ];

    selectors.forEach(selector => {
      const el = document.querySelector(selector);
      if (el) {
        targets.push(el);
      }
    });

    targets.push(document.scrollingElement, document.body, document.documentElement);

    return dedupe(targets.filter(Boolean));
  };

  const scrollElement = (element, direction = 1) => {
    const snapshotPosition = () => {
      if (!element) {
        return 0;
      }

      if (element === window || element === document.body || element === document.documentElement) {
        return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
      }

      return typeof element.scrollTop === 'number' ? element.scrollTop : 0;
    };

    const performScroll = () => {
      if (!element) {
        return;
      }
      const deltaFactor = Math.max(0.2, Math.min(1, Math.abs(direction))) * Math.sign(direction || 1);
      const deltaWindow = deltaFactor * Math.max(600, window.innerHeight || 800);
      if (element === window || element === document.body || element === document.documentElement) {
        window.scrollBy(0, deltaWindow);
      } else if (typeof element.scrollBy === 'function') {
        element.scrollBy({ top: deltaFactor * element.clientHeight * 0.9, behavior: 'auto' });
      } else if (typeof element.scrollTop === 'number') {
        const delta = deltaFactor * element.clientHeight * 0.9;
        const next = element.scrollTop + delta;
        if (delta >= 0) {
          element.scrollTop = Math.min(next, element.scrollHeight);
        } else {
          element.scrollTop = Math.max(0, next);
        }
      }
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    };

    const before = snapshotPosition();
    performScroll();
    const after = snapshotPosition();
    const moved = after > before;

    return { moved, after, before };
  };

  const ensureMovementOrRetry = async (element) => {
    const initial = scrollElement(element, 1);
    if (initial && initial.moved) {
      return true;
    }

    if (!element) {
      return false;
    }

    await wait(400);
    const retry = scrollElement(element, 1);
    return Boolean(retry && retry.moved);
  };

  const tryClickLoadMore = () => {
    const loaders = [
      () => document.querySelector('button[data-testid="pdp-review-paging-button"]'),
      () => document.querySelector('button[data-testid="pdp-show-all-reviews-button"]'),
      () => Array.from(document.querySelectorAll('button[aria-label]')).find(btn => {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        return aria.includes('more') && aria.includes('review');
      }),
      () => Array.from(document.querySelectorAll('button')).find(btn => {
        const text = (btn.textContent || '').toLowerCase();
        return text.includes('show more') && text.includes('review');
      })
    ];

    return clickCandidates(loaders);
  };

  await ensureReviewsContainerOpen();

  let lastCount = collectReviews();
  let idleCycles = 0;
  const MAX_IDLE_CYCLES = expected ? Math.min(24, Math.max(10, Math.ceil(expected / 8))) : 15;
  const MAX_SCROLL_CYCLES = expected ? Math.max(60, Math.ceil(expected * 1.5)) : 60;
  let stallLoops = 0;
  let noGrowthCycles = 0;

  console.log('Starting review loading with expected total:', expected || 'unknown');

  const attemptRecovery = async (attemptNumber) => {
    const magnitude = -0.4 - attemptNumber * 0.15;
    const targets = getScrollableTargets();
    targets.forEach(target => scrollElement(target, magnitude));
    await wait(700 + attemptNumber * 200);
    const downMoves = await Promise.all(targets.map(el => ensureMovementOrRetry(el)));
    return downMoves.some(Boolean);
  };

  let gaveUpEarly = false;

  for (let cycle = 1; cycle <= MAX_SCROLL_CYCLES; cycle += 1) {
    await ensureReviewsContainerOpen();

    const targets = getScrollableTargets();
    if (!targets.length) {
      idleCycles += 1;
      console.log('No scrollable targets found, idle cycle', idleCycles);
      if (idleCycles > MAX_IDLE_CYCLES) {
        break;
      }
      await wait(600);
      continue;
    }

    const movementAttempts = await Promise.all(targets.map(ensureMovementOrRetry));
    let anyMoved = movementAttempts.some(Boolean);

    if (!anyMoved) {
      let recovered = false;
      for (let attempt = 0; attempt < 3 && !recovered; attempt += 1) {
        recovered = await attemptRecovery(attempt);
        if (!recovered) {
          try {
            const dialog = document.querySelector('[role="dialog"]');
            const scrollable = dialog || document.scrollingElement || document.body;
            if (scrollable) {
              scrollable.scrollIntoView({ block: 'center', behavior: 'instant' });
            }
          } catch (error) {
            console.debug('Failed to scroll into view during recovery', error);
          }
          await wait(400);
        }
      }
      anyMoved = recovered;
    }
    const clicked = tryClickLoadMore();

    if (clicked) {
      await wait(anyMoved ? 400 : 2400);
    } else {
      await wait(anyMoved ? 100 : 600);
    }

    if (!expected || !Number.isFinite(expected)) {
      const badgeCount = readTotalBadge();
      if (Number.isFinite(badgeCount) && badgeCount > 0) {
        expected = badgeCount;
      }
    }

    const currentCount = collectReviews();
    updateTitle(currentCount, 'reviews processed');
    console.log(`Cycle ${cycle}: seen ${currentCount} reviews (expected ${expected || 'unknown'})`);

    if (expected && currentCount >= expected) {
      console.log('Reached expected review total');
      break;
    }

    if (currentCount > lastCount || anyMoved) {
      idleCycles = 0;
      stallLoops = 0;
      noGrowthCycles = 0;
      lastCount = currentCount;
    } else {
      idleCycles += 1;
      stallLoops += 1;
      noGrowthCycles += 1;
      if (noGrowthCycles >= 5) {
        console.warn('No new reviews after multiple cycles, treating as complete');
        if (!expected || currentCount >= expected - 1) {
          expected = currentCount;
        }
        break;
      }
      if (idleCycles > MAX_IDLE_CYCLES) {
        break;
      }
      if (stallLoops >= 20) {
        console.warn('Exiting review scroll after repeated stalls');
        gaveUpEarly = true;
        break;
      }
    }
  }

  const finalCount = collectReviews();
  const missing = expected ? Math.max(0, expected - finalCount) : 0;
  if (missing > 0 && (gaveUpEarly || finalCount < expected)) {
    updateTitle(finalCount, 'reviews processed (incomplete)');
    console.warn('Failed to reach expected reviews', { expected, finalCount });
  } else {
    updateTitle(finalCount, 'reviews processed (complete)');
    console.log('Finished loading reviews', { finalCount, expected });
  }

  return {
    count: finalCount,
    expected,
    missing,
    gaveUp: missing > 0 && (gaveUpEarly || finalCount < expected)
  };
}

// Extract only reviews from reviews page
function extractReviewsOnly() {
  const reviews = [];
  
  try {
    console.log('Looking for reviews on reviews page...');
    
    // On the reviews modal page, reviews are in specific containers
    let reviewElements = document.querySelectorAll('[data-review-id]');
    console.log('Found reviews with data-review-id:', reviewElements.length);
    
    // Fallback: look in reviews section
    if (reviewElements.length === 0) {
      const reviewsSection = document.querySelector('[data-section-id="REVIEWS_DEFAULT"]');
      if (reviewsSection) {
        reviewElements = reviewsSection.querySelectorAll('div[role="listitem"]');
        console.log('Found reviews in section:', reviewElements.length);
      }
    }
    
    const selectBestReviewText = (spanNodes) => {
      const candidates = [];

      spanNodes.forEach(span => {
        const text = span.textContent.trim();
        if (!text) {
          return;
        }
        const lower = text.toLowerCase();
        if (lower.includes('show more') || lower.includes('show original') || lower.includes('translated')) {
          return;
        }
        if (span.children.length > 1) {
          return;
        }

        let depth = 0;
        let current = span;
        while (current && current.parentElement) {
          depth += 1;
          current = current.parentElement;
        }

        candidates.push({
          text,
          length: text.length,
          depth,
          hasChild: span.children.length > 0
        });
      });

      if (candidates.length === 0) {
        return '';
      }

      const scoreForLength = (length) => {
        if (length >= 300) return 3;
        if (length >= 120) return 2;
        if (length >= 40) return 1;
        return 0;
      };

      candidates.sort((a, b) => {
        const scoreDiff = scoreForLength(b.length) - scoreForLength(a.length);
        if (scoreDiff !== 0) return scoreDiff;
        if (b.length !== a.length) return b.length - a.length;
        if (a.hasChild !== b.hasChild) return a.hasChild ? 1 : -1;
        return a.depth - b.depth;
      });

      return candidates[0].text;
    };

    const readReviewDate = (root) => {
      if (!root) {
        return '';
      }

      const formatISODate = (value) => {
        if (!value) {
          return null;
        }
        const trimmed = value.trim();
        const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!isoMatch) {
          return null;
        }
        const parsed = new Date(trimmed);
        if (Number.isNaN(parsed.getTime())) {
          return trimmed;
        }
        return parsed.toLocaleDateString('en-GB', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
      };

      const extractFromText = (rawText) => {
        if (!rawText) {
          return null;
        }
        const text = rawText.replace(/\s+/g, ' ').trim();
        if (!text) {
          return null;
        }

        const isoEmbedded = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
        if (isoEmbedded) {
          const formatted = formatISODate(isoEmbedded[0]);
          if (formatted) {
            return formatted;
          }
        }

        const monthDayYear = text.match(/\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i);
        if (monthDayYear) {
          return monthDayYear[0].replace(/\s+/g, ' ').trim();
        }

        const monthYear = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i);
        if (monthYear) {
          return monthYear[0].replace(/\s+/g, ' ').trim();
        }

        const shortMonthYear = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4}\b/i);
        if (shortMonthYear) {
          const cleaned = shortMonthYear[0].replace(/\./g, '');
          return cleaned.replace(/\s+/g, ' ').trim();
        }

        const localizedMonthYear = text.match(/\b([\p{L}]{3,})\s+\d{4}\b/iu);
        if (localizedMonthYear) {
          return localizedMonthYear[0].replace(/\s+/g, ' ').trim();
        }

        const stayedMonthOnly = text.match(/(?:Stayed in|Se hosped[oó] en|Ha soggiornato a|Ha soggiornato in|Verblieb im|Stayed at)\s+([\p{L}]{3,})\b/iu);
        if (stayedMonthOnly) {
          return stayedMonthOnly[0].replace(/\s+/g, ' ').trim();
        }

        const stayedIn = text.match(/Stayed in\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i);
        if (stayedIn) {
          return stayedIn[0].replace(/\s+/g, ' ').trim();
        }

        return null;
      };

      const seenNodes = new Set();
      const enqueue = (node, queue) => {
        if (!node || seenNodes.has(node)) {
          return;
        }
        seenNodes.add(node);
        queue.push(node);
      };

      const considerNode = (node) => {
        if (!node) {
          return null;
        }

        const datetime = node.getAttribute?.('datetime');
        const datetimeFormatted = formatISODate(datetime);
        if (datetimeFormatted) {
          return datetimeFormatted;
        }

        const attrCandidates = [
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          node.getAttribute?.('aria-description'),
          node.getAttribute?.('data-date')
        ];

        if (node.dataset) {
          attrCandidates.push(...Object.values(node.dataset));
        }

        for (const candidate of attrCandidates) {
          const extracted = extractFromText(candidate);
          if (extracted) {
            return extracted;
          }
          const formatted = formatISODate(candidate);
          if (formatted) {
            return formatted;
          }
        }

        const textExtracted = extractFromText(node.textContent);
        if (textExtracted) {
          return textExtracted;
        }

        return null;
      };

      const queue = [];
      enqueue(root.querySelector('time'), queue);
      root.querySelectorAll('[data-testid*="date" i]').forEach(node => enqueue(node, queue));
      root.querySelectorAll('[data-testid*="arrival" i]').forEach(node => enqueue(node, queue));
      root.querySelectorAll('[class*="date" i]').forEach(node => enqueue(node, queue));
      root.querySelectorAll('[class*="arrival" i]').forEach(node => enqueue(node, queue));
      root.querySelectorAll('[class*="stay" i]').forEach(node => enqueue(node, queue));
      root.querySelectorAll('span').forEach(node => enqueue(node, queue));
      root.querySelectorAll('div').forEach(node => enqueue(node, queue));

      enqueue(root.previousElementSibling, queue);
      enqueue(root.nextElementSibling, queue);
      enqueue(root.parentElement, queue);
      Array.from(root.children).forEach(child => enqueue(child, queue));

      while (queue.length) {
        const node = queue.shift();
        const extracted = considerNode(node);
        if (extracted) {
          return extracted;
        }
      }

      return extractFromText(root.textContent) || '';
    };

    reviewElements.forEach((reviewEl) => {
      const review = {
        text: '',
        rating: 'N/A',
        date: ''
      };

      // Extract review text - find the longest meaningful span
      const textSpans = reviewEl.querySelectorAll('span');
      review.text = selectBestReviewText(textSpans);

      // Extract date
      review.date = readReviewDate(reviewEl);

      if (review.text) {
        reviews.push(review);
      }
    });
    
    console.log('Successfully extracted', reviews.length, 'reviews');
  } catch (error) {
    console.error('Error extracting reviews:', error);
  }

  return reviews;
}

function generateLLMPrompt(propertiesData) {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let prompt = `Today is ${formattedDate}.

You are an assistant that must ask exactly one clarification question before starting a task. After greeting me, ask only: "Do you have any requirements you want me to take into account?" If my answer is sensible, acknowledge it and proceed without asking further follow-ups. Only ask additional questions if my reply is ambiguous or contradictory. Always respect the requirements I name. Relevant requirements might include minimum bedrooms, washer/dryer availability, budget range, accessibility needs, preferred neighbourhoods, or other deal-breakers.

I'm analyzing ${propertiesData.length} Airbnb properties from my wishlist. I need you to carefully review each property's details and reviews, paying special attention to subtle hints and concerns that guests might mention even when giving high ratings. People often soften negative feedback or bury concerns in otherwise positive reviews, especially when the host is friendly. Whenever you reference a specific property in your response, include its direct URL so I can click through immediately.

While analyzing reviews, explicitly note if a property has mostly old reviews and highlight any risks that the information may be outdated.

Please analyze:
1. Hidden red flags in reviews (e.g., mentions of issues followed by "but it was fine")
2. Patterns across multiple reviews suggesting consistent problems
3. Property features and amenities that might be misleading or concerning
4. Any recurring concerns or complaints
5. Properties with suspiciously few or no reviews

After analyzing all properties, provide:
- **Top 3 Best Properties**: With reasons why they stand out based on reviews and features
- **Top 3 Properties to Avoid**: With specific concerns from reviews
- **Key Insights**: Overall patterns or important considerations

---

`;

  propertiesData.forEach((property, index) => {
    prompt += `\n## PROPERTY ${index + 1}\n\n`;
    const titleText = property.title ? property.title.trim() : '';
    const url = property.url ? property.url.trim() : '';
    const titleLine = url ? `[${titleText || `Property ${index + 1}`}](${url})` : (titleText || `Property ${index + 1}`);

    prompt += `**Title**: ${titleLine}\n`;
    prompt += `**URL**: ${url || 'N/A'}\n`;
    const ratingText = property.rating ? `${property.rating} out of 5` : 'N/A';
    prompt += `**Overall Rating**: ${ratingText} (${property.reviewCount || 0} reviews)\n\n`;

    if (property.reviewShortfall) {
      prompt += `⚠️ Unable to retrieve the last ${property.reviewShortfall} reviews due to repeated loading stalls.\n\n`;
    }
    
    if (property.error) {
      prompt += `**Error**: ${property.error}\n\n`;
    } else {
      // Property details
      if (property.guests || property.bedrooms || property.beds || property.bathrooms) {
        prompt += `**Property Details**:\n`;
        if (property.guests) prompt += `- ${property.guests} guests\n`;
        if (property.bedrooms) prompt += `- ${property.bedrooms} bedrooms\n`;
        if (property.beds) prompt += `- ${property.beds} beds\n`;
        if (property.bathrooms) prompt += `- ${property.bathrooms} bathrooms\n`;
        prompt += `\n`;
      }
      
      // Description
      if (property.description) {
        prompt += `**Description**:\n${property.description}\n\n`;
      }
      
      // Amenities
      if (property.amenities && property.amenities.length > 0) {
        prompt += `**Amenities**:\n`;
        property.amenities.forEach(amenity => {
          prompt += `${amenity}\n`;
        });
        prompt += `\n`;
      }
      
      // Reviews
      if (property.reviews && property.reviews.length > 0) {
        prompt += `**Reviews (${property.reviews.length} shown)**:\n\n`;
        property.reviews.forEach((review, idx) => {
          prompt += `Review ${idx + 1} - ${review.date || 'N/A'}\n`;
          prompt += `"${review.text}"\n\n`;
        });
      } else {
        prompt += `**Reviews**: No reviews available for this property\n\n`;
      }
    }
    
    prompt += `---\n`;
  });

  return prompt;
}

function generateSinglePropertyPrompt(property) {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const safeValue = (value) => value || 'N/A';
  const titleText = property.title ? property.title.trim() : '';
  const url = property.url ? property.url.trim() : '';
  const titleLine = url ? `[${titleText || 'This property'}](${url})` : (titleText || 'This property');

  let prompt = `Today is ${formattedDate}.\n\nYou are an assistant that will answer questions about a single Airbnb listing using only the details and guest reviews provided below. Surface risks even if they are hinted softly.\n\n`;

  prompt += `## PROPERTY DETAILS\n\n`;
  prompt += `**Title**: ${titleLine}\n`;
  prompt += `**URL**: ${url || 'N/A'}\n`;
  prompt += `**Overall Rating**: ${property.rating ? `${property.rating} out of 5` : 'N/A'} (${property.reviewCount || 0} reviews)\n\n`;

  if (property.reviewShortfall) {
    prompt += `⚠️ Reviews may be incomplete (missing last ${property.reviewShortfall}).\n\n`;
  }

  if (property.error) {
    prompt += `**Error**: ${property.error}\n\n`;
    return prompt;
  }

  if (property.guests || property.bedrooms || property.beds || property.bathrooms) {
    prompt += `**Capacity & Layout**:\n`;
    if (property.guests) prompt += `- ${property.guests} guests\n`;
    if (property.bedrooms) prompt += `- ${property.bedrooms} bedrooms\n`;
    if (property.beds) prompt += `- ${property.beds} beds\n`;
    if (property.bathrooms) prompt += `- ${property.bathrooms} bathrooms\n`;
    prompt += `\n`;
  }

  if (property.description) {
    prompt += `**Description**:\n${property.description}\n\n`;
  }

  if (property.amenities && property.amenities.length > 0) {
    prompt += `**Amenities**:\n`;
    property.amenities.forEach((amenity) => {
      prompt += `${amenity}\n`;
    });
    prompt += `\n`;
  }

  if (property.reviews && property.reviews.length > 0) {
    prompt += `**Reviews (${property.reviews.length} shown)**:\n\n`;
    property.reviews.forEach((review, idx) => {
      prompt += `Review ${idx + 1} - ${safeValue(review.date)}\n`;
      prompt += `"${safeValue(review.text)}"\n\n`;
    });
  } else {
    prompt += `**Reviews**: No reviews available for this property\n\n`;
  }

  prompt += `Focus on identifying hidden red flags, patterns in the feedback, and whether reviews are outdated. Use these notes to answer any follow-up questions about this listing.\n`;

  return prompt;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
