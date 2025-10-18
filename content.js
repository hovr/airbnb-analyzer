// Content script that runs on Airbnb wishlist pages
let extractionInProgress = false;

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

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getWishlistInfo') {
    const propertyLinks = getPropertyLinks();
    chrome.storage.local.set({ propertyCount: propertyLinks.length });
    sendResponse({
      status: 'ok',
      propertyCount: propertyLinks.length,
      extractionInProgress
    });
    return false;
  }

  if (message.action === 'complete' || message.action === 'error') {
    extractionInProgress = false;
    return false;
  }

  if (message.action === 'progress') {
    return false;
  }

  if (message.action === 'startExtraction' && !extractionInProgress) {
    extractionInProgress = true;
    
    // Get property links and send to background script
    const propertyLinks = getPropertyLinks();
    
    if (propertyLinks.length === 0) {
      safeSendRuntimeMessage({
        action: 'error',
        error: 'No properties found on this page. Make sure you\'re on a wishlist page.'
      });
      extractionInProgress = false;
      sendResponse({ status: 'error' });
      return;
    }

    // Store property count and clear previous analysis
    chrome.storage.local.set({
      propertyCount: propertyLinks.length,
      analysisPrompt: null,
      lastExtractionTotal: 0
    });
    
    // Send links to background script to handle extraction
    safeSendRuntimeMessage({
      action: 'extractProperties',
      propertyLinks: propertyLinks
    });
    
    sendResponse({ status: 'started' });
    return true;
  }
  return false;
});

// Get all property links and titles from the wishlist
function getPropertyLinks() {
  const properties = [];
  // Airbnb uses various selectors, these are common ones
  const propertyCards = document.querySelectorAll('a[href*="/rooms/"]');
  
  propertyCards.forEach(card => {
    const href = card.getAttribute('href');
    if (href && href.includes('/rooms/')) {
      // Extract clean URL
      const url = href.startsWith('http') ? href : 'https://www.airbnb.co.uk' + href.split('?')[0];
      
      // Get the title from the card
      let title = '';
      const titleElement = card.querySelector('[data-testid="listing-card-title"]') ||
                          card.querySelector('div[id*="title"]') ||
                          card.closest('[data-testid="card-container"]')?.querySelector('[id*="title"]');
      
      if (titleElement) {
        title = titleElement.textContent.trim();
      }
      
      // Get rating and review count from the card
      let rating = '';
      let reviewCount = '';
      
      // Look for rating and review count inside the card
      const cardContainer = card.closest('[data-testid="card-container"]') || card.parentElement;
      if (cardContainer) {
        const textCandidates = [
          cardContainer.textContent || ''
        ];

        const ariaReviewNode = cardContainer.querySelector('[aria-label*="review" i]');
        if (ariaReviewNode && ariaReviewNode.getAttribute('aria-label')) {
          textCandidates.unshift(ariaReviewNode.getAttribute('aria-label'));
        }

        const parseRatingFromText = (source) => {
          if (!source) {
            return null;
          }

          const patterns = [
            /Rated\s*([0-5](?:\.\d{1,2})?)/i,
            /([0-5](?:\.\d{1,2})?)\s*[·,]\s*(?:\d{1,4}(?:,\d{3})*)\s+reviews?/i,
            /([0-5](?:\.\d{1,2})?)\s*out of\s*5/i,
            /([0-5](?:\.\d{1,2})?)\s*(?:stars?)/i
          ];

          for (const pattern of patterns) {
            const match = source.match(pattern);
            if (match) {
              const value = Number.parseFloat(match[1]);
              if (!Number.isNaN(value) && value > 0 && value <= 5) {
                return match[1];
              }
            }
          }

          return null;
        };

        for (const source of textCandidates) {
          if (!source) {
            continue;
          }

          if (!rating) {
            const parsedRating = parseRatingFromText(source);
            if (parsedRating) {
              rating = parsedRating;
            }
          }

          if (!reviewCount) {
            const reviewMatch = source.match(/\b(\d{1,4}(?:,\d{3})*)\b(?=\s*reviews?)/i);
            if (reviewMatch) {
              reviewCount = reviewMatch[1].replace(/,/g, '');
              break;
            }
          }
        }
      }
      
      // Check if we already have this property
      const existingProperty = properties.find(p => p.url === url);
      if (!existingProperty) {
        properties.push({
          url,
          title,
          rating,
          reviewCount
        });
      }
    }
  });
  
  return properties;
}

// Initialize - get property count when page loads
setTimeout(() => {
  const propertyLinks = getPropertyLinks();
  chrome.storage.local.set({ propertyCount: propertyLinks.length });
}, 1000);