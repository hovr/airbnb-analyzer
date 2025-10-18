// Background service worker to handle tab operations and data extraction

const safeSendRuntimeMessage = (payload) => {
  try {
    chrome.runtime.sendMessage(payload, () => {
      if (chrome.runtime.lastError) {
        console.debug('runtime.sendMessage ignored:', chrome.runtime.lastError.message);
      }
    });
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

  // Forward progress/complete/error messages to popup
  if (message.action === 'progress' || message.action === 'complete' || message.action === 'error') {
    // This will be received by popup.js
    return false;
  }
});

async function extractAllProperties(propertyLinks) {
  const propertiesData = [];
  const CONCURRENCY_LIMIT = 5;

  await chrome.storage.local.set({ 
    extractionInProgress: true,
    currentProperty: 0,
    totalProperties: propertyLinks.length,
    lastExtractionTotal: 0,
    analysisPrompt: null
  });

  let nextIndex = 0;
  let completed = 0;

  const results = new Array(propertyLinks.length);
  const activeIndices = new Set();

  const buildProgressList = () => {
    const sorted = Array.from(activeIndices).sort((a, b) => a - b);
    if (!sorted.length) {
      return `${Math.min(completed + 1, propertyLinks.length)}`;
    }
    return sorted.map(idx => idx + 1).join(', ');
  };

  const launchNext = async () => {
    if (nextIndex >= propertyLinks.length) {
      return;
    }

    const currentIndex = nextIndex;
    nextIndex += 1;

    const linkData = propertyLinks[currentIndex];
    activeIndices.add(currentIndex);

    safeSendRuntimeMessage({
      action: 'progress',
      current: buildProgressList(),
      total: propertyLinks.length,
      propertyName: `Processing properties: ${buildProgressList()}`
    });

    await chrome.storage.local.set({ currentProperty: currentIndex + 1 });

    try {
      const data = await extractPropertyData(linkData.url, linkData.title, linkData.rating, linkData.reviewCount);
      results[currentIndex] = data;
    } catch (error) {
      console.error(`Error extracting ${linkData.url}:`, error);
      results[currentIndex] = {
        url: linkData.url,
        title: linkData.title,
        error: 'Failed to extract data: ' + error.message
      };
    } finally {
      activeIndices.delete(currentIndex);
      completed += 1;

      if (completed < propertyLinks.length) {
        safeSendRuntimeMessage({
          action: 'progress',
          current: buildProgressList(),
          total: propertyLinks.length,
          propertyName: `Processing properties: ${buildProgressList()}`
        });
        await launchNext();
      }
    }
  };

  const starters = Math.min(CONCURRENCY_LIMIT, propertyLinks.length);
  const running = [];
  for (let i = 0; i < starters; i += 1) {
    running.push(launchNext());
  }

  await Promise.all(running);
  propertiesData.push(...results.filter(Boolean));

  // Generate the LLM prompt
  const prompt = generateLLMPrompt(propertiesData);
  
  // Store the prompt and clear progress state
  await chrome.storage.local.set({ 
    analysisPrompt: prompt,
    extractionInProgress: false,
    currentProperty: 0,
    totalProperties: 0,
    lastExtractionTotal: propertyLinks.length
  });

  // Send completion message
  safeSendRuntimeMessage({
    action: 'complete',
    total: propertyLinks.length
  });
}

async function extractPropertyData(url, title, wishlistRating, wishlistReviewCount) {
  const propertyId = url.match(/\/rooms\/(\d+)/)?.[1];
  
  // First, open the main property page to get details
  const mainTab = await chrome.tabs.create({ url: url, active: false });
  await sleep(3000);
  
  try {
    // Extract basic info from main page
    const mainPageData = await chrome.scripting.executeScript({
      target: { tabId: mainTab.id },
      func: extractMainPageData,
      args: [title, wishlistRating, wishlistReviewCount]
    });
    
    const propertyData = mainPageData && mainPageData[0] ? mainPageData[0].result : {};
    
    // Close main tab
    await chrome.tabs.remove(mainTab.id);
    
    // Now open reviews page if there are reviews
    if (propertyData.reviewCount && propertyData.reviewCount !== '0') {
      const reviewsUrl = `https://www.airbnb.co.uk/rooms/${propertyId}/reviews`;
      const reviewsTab = await chrome.tabs.create({ url: reviewsUrl, active: false });
      await sleep(4000); // Wait longer for initial load
      
      try {
        // Scroll to load ALL reviews
        const scrollResult = await chrome.scripting.executeScript({
          target: { tabId: reviewsTab.id },
          func: scrollAndLoadAllReviews,
          args: [Number.parseInt(propertyData.reviewCount, 10) || null]
        });
        
        const finalLoadedCount = scrollResult && scrollResult[0] ? scrollResult[0].result : null;
        if (Number.isFinite(finalLoadedCount)) {
          propertyData.loadedReviewCount = finalLoadedCount;
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
        
        await chrome.tabs.remove(reviewsTab.id);
      } catch (error) {
        console.error('Error extracting reviews:', error);
        try {
          await chrome.tabs.remove(reviewsTab.id);
        } catch (e) {}
      }
    }
    
    return propertyData;
  } catch (error) {
    try {
      await chrome.tabs.remove(mainTab.id);
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
        const ratingText = ratingLink.textContent;
        const ratingMatch = ratingText.match(/([\d.]+)/);
        const reviewMatch = ratingText.match(/(\d{1,4}(?:,\d{3})*)\s+reviews?/i);
        if (!data.rating && ratingMatch) {
          applyRating(ratingMatch[1]);
        }
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
        document.querySelector('[data-testid="rating-section"]')
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
          if (applyReviewCount(candidate)) {
            resolvedFromButtons = true;
            break;
          }
        }
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
async function scrollAndLoadAllReviews(expectedTotal) {
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

  const collectReviews = () => {
    const reviewNodes = document.querySelectorAll('[data-review-id]');
    reviewNodes.forEach(node => {
      const reviewId = node.getAttribute('data-review-id') || node.id;
      if (reviewId) {
        seenReviewIds.add(reviewId);
      }
    });
    return seenReviewIds.size;
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

  const scrollElement = (element) => {
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
      if (element === window || element === document.body || element === document.documentElement) {
        window.scrollBy(0, Math.max(600, window.innerHeight || 800));
      } else if (typeof element.scrollBy === 'function') {
        element.scrollBy({ top: element.clientHeight * 0.9, behavior: 'auto' });
      } else if (typeof element.scrollTop === 'number') {
        element.scrollTop = Math.min(element.scrollTop + element.clientHeight * 0.9, element.scrollHeight);
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
    const initial = scrollElement(element);
    if (initial && initial.moved) {
      return true;
    }

    if (!element) {
      return false;
    }

    await wait(400);
    const retry = scrollElement(element);
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

  console.log('Starting review loading with expected total:', expected || 'unknown');

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

    const movementResults = await Promise.all(targets.map(ensureMovementOrRetry));
    const anyMoved = movementResults.some(Boolean);
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
    console.log(`Cycle ${cycle}: seen ${currentCount} reviews (expected ${expected || 'unknown'})`);

    if (expected && currentCount >= expected) {
      console.log('Reached expected review total');
      break;
    }

    if (currentCount > lastCount || anyMoved) {
      idleCycles = 0;
      lastCount = currentCount;
    } else {
      idleCycles += 1;
      if (idleCycles > MAX_IDLE_CYCLES) {
        break;
      }
    }
  }

  const finalCount = collectReviews();
  if (expected && finalCount < expected) {
    console.warn('Failed to reach expected reviews', { expected, finalCount });
  } else {
    console.log('Finished loading reviews', { finalCount, expected });
  }

  return finalCount;
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

Before you begin any analysis, ask me to clarify the must-have requirements for this trip (for example: minimum bedrooms, washer/dryer availability, budget range, accessibility needs, preferred neighbourhoods, or other deal-breakers). Wait for my response, then continue with the analysis below.

I'm analyzing ${propertiesData.length} Airbnb properties from my wishlist. I need you to carefully review each property's details and reviews, paying special attention to subtle hints and concerns that guests might mention even when giving high ratings. People often soften negative feedback or bury concerns in otherwise positive reviews, especially when the host is friendly.

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}