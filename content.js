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

    // Store property count
    chrome.storage.local.set({ propertyCount: propertyLinks.length });
    
    // Send links to background script to handle extraction
    safeSendRuntimeMessage({
      action: 'extractProperties',
      propertyLinks: propertyLinks
    });
    
    sendResponse({ status: 'started' });
  }
  return true;
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
      
      // Look for rating in the card (usually shows "4.86 (72)")
      const cardContainer = card.closest('[data-testid="card-container"]') || card.parentElement;
      if (cardContainer) {
        const ratingText = cardContainer.textContent;
        // Pattern like "4.86 (72)" or "4.86·72 reviews"
      const ratingPattern = /([0-5](?:\.\d{1,2})?)\s*[·(]\s*(\d{1,5})/;
        const match = ratingText.match(ratingPattern);
        if (match) {
          rating = match[1];
          reviewCount = match[2];
        }
      }
      
      // Check if we already have this property
      const existingProperty = properties.find(p => p.url === url);
      if (!existingProperty) {
        properties.push({ url, title, rating, reviewCount });
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