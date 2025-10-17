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
  const BATCH_SIZE = 3; // Process 3 properties at a time
  
  // Store initial state
  await chrome.storage.local.set({ 
    extractionInProgress: true,
    currentProperty: 0,
    totalProperties: propertyLinks.length,
    lastExtractionTotal: 0,
    analysisPrompt: null
  });

  // Process properties in batches
  for (let i = 0; i < propertyLinks.length; i += BATCH_SIZE) {
    const batch = propertyLinks.slice(i, i + BATCH_SIZE);
    
    // Build the progress message for this batch
    const batchNumbers = batch.map((_, idx) => i + idx + 1);
    const batchMessage = batchNumbers.join(', ');
    
    // Send progress update showing all properties in current batch
    safeSendRuntimeMessage({
      action: 'progress',
      current: batchMessage,
      total: propertyLinks.length,
      propertyName: `Processing properties: ${batchMessage}`
    });
    
    // Process batch in parallel
    const batchPromises = batch.map(async (linkData, batchIndex) => {
      const actualIndex = i + batchIndex;
      const url = linkData.url;
      const title = linkData.title;
      
      // Update current property index
      await chrome.storage.local.set({ currentProperty: actualIndex + 1 });

      try {
        const data = await extractPropertyData(url, title, linkData.rating, linkData.reviewCount);
        return data;
      } catch (error) {
        console.error(`Error extracting ${url}:`, error);
        return {
          url: url,
          title: title,
          error: 'Failed to extract data: ' + error.message
        };
      }
    });

    // Wait for all properties in the batch to complete
    const batchResults = await Promise.all(batchPromises);
    propertiesData.push(...batchResults);
    
    // Small delay between batches
    if (i + BATCH_SIZE < propertyLinks.length) {
      await sleep(1000);
    }
  }

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
        await chrome.scripting.executeScript({
          target: { tabId: reviewsTab.id },
          func: scrollAndLoadAllReviews
        });
        
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
    reviewCount: wishlistReviewCount || '',
    guests: '',
    bedrooms: '',
    beds: '',
    bathrooms: '',
    description: '',
    amenities: []
  };

  try {
    // Only try to extract rating if we don't already have it from wishlist
    if (!data.rating) {
      console.log('Looking for rating on property page...');
      
      // Try to extract from property page as fallback
      const ratingLink = document.querySelector('a[href*="/reviews"]');
      if (ratingLink) {
        console.log('Found rating link:', ratingLink.textContent);
        const ratingText = ratingLink.textContent;
        const ratingMatch = ratingText.match(/([\d.]+)/);
        const reviewMatch = ratingText.match(/(\d{1,5})\s+review/i);
        if (ratingMatch) {
          const fallbackRating = parseFloat(ratingMatch[1]);
          if (!Number.isNaN(fallbackRating) && fallbackRating > 0 && fallbackRating <= 5) {
            data.rating = ratingMatch[1];
          }
        }
        if (reviewMatch) data.reviewCount = reviewMatch[1];
      }
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
function scrollAndLoadAllReviews() {
  return new Promise((resolve) => {
    const clickLoadMoreReviewsButton = () => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const button of buttons) {
        const text = (button.textContent || '').trim().toLowerCase();
        if (text.includes('show more') && text.includes('review') && !button.disabled) {
          button.click();
          return true;
        }
      }
      const ariaButton = document.querySelector('button[aria-label*="show more reviews" i]');
      if (ariaButton && !ariaButton.disabled) {
        ariaButton.click();
        return true;
      }
      return false;
    };

    const isScrollableElement = (element) => {
      if (!element) {
        return false;
      }
      const style = getComputedStyle(element);
      const overflowY = style.overflowY;

      if (element === document.body || element === document.documentElement) {
        return element.scrollHeight > element.clientHeight + 20;
      }

      if (overflowY === 'auto' || overflowY === 'scroll') {
        return element.scrollHeight > element.clientHeight + 20;
      }

      return false;
    };

    const findScrollableDescendant = (root) => {
      if (!root) {
        return null;
      }
      if (isScrollableElement(root)) {
        return root;
      }
      const descendants = root.querySelectorAll('*');
      for (const descendant of descendants) {
        if (isScrollableElement(descendant)) {
          return descendant;
        }
      }
      return null;
    };

    let scrollCount = 0;
    let consecutiveNoChange = 0;
    let scrollContainer = null;
    let attemptsWithoutContainer = 0;
    const seenReviewIds = new Set();
    let lastUniqueReviewCount = 0;
    let waitingForLoadMore = false;

    console.log('Starting to scroll for reviews...');

    const findScrollContainer = () => {
      const candidates = [
        document.querySelector('[role="dialog"]'),
        document.querySelector('[data-testid="modal-container"]'),
        document.querySelector('main'),
        document.querySelector('[style*="overflow-y"]'),
        document.querySelector('[style*="overflow: auto"]'),
        document.body,
        document.documentElement
      ];

      for (const candidate of candidates) {
        const scrollable = findScrollableDescendant(candidate);
        if (scrollable) {
          console.log('Found scrollable container:', scrollable.tagName, scrollable.className || scrollable.id || '');
          return scrollable;
        }
      }
      const fallback = document.scrollingElement || document.body;
      console.log('Falling back to scrolling element:', fallback.tagName || 'document');
      return fallback;
    };

    const performScroll = () => {
      if (!scrollContainer || !document.contains(scrollContainer)) {
        scrollContainer = findScrollContainer();
        if (!scrollContainer) {
          attemptsWithoutContainer++;
          console.log(`Waiting for reviews container (${attemptsWithoutContainer}/40)`);
          if (attemptsWithoutContainer >= 40) {
            clearInterval(scrollInterval);
            resolve();
            return;
          }
          return;
        }
        console.log('Using scroll container:', scrollContainer.tagName, scrollContainer.className || scrollContainer.id || '');
      }

      if (scrollContainer === document.body || scrollContainer === document.documentElement) {
        window.scrollTo(0, document.body.scrollHeight);
      } else if (typeof scrollContainer.scrollTo === 'function') {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'auto' });
      } else {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }

      scrollCount++;

      const currentReviewElements = document.querySelectorAll('[data-review-id]');
      currentReviewElements.forEach(el => {
        const reviewId = el.getAttribute('data-review-id');
        if (reviewId) {
          seenReviewIds.add(reviewId);
        }
      });
      const uniqueReviewCount = seenReviewIds.size;
      console.log(`Scroll ${scrollCount}: Unique reviews seen ${uniqueReviewCount}`);

      const loadMoreClicked = clickLoadMoreReviewsButton();
      if (loadMoreClicked) {
        console.log('Clicked load more reviews button');
        waitingForLoadMore = true;
      }

      setTimeout(() => {
        const newReviewElements = document.querySelectorAll('[data-review-id]');
        newReviewElements.forEach(el => {
          const reviewId = el.getAttribute('data-review-id');
          if (reviewId) {
            seenReviewIds.add(reviewId);
          }
        });
        const newUniqueReviewCount = seenReviewIds.size;

        if (newUniqueReviewCount > lastUniqueReviewCount) {
          consecutiveNoChange = 0;
          waitingForLoadMore = false;
          console.log(`New reviews loaded! ${lastUniqueReviewCount} -> ${newUniqueReviewCount}`);
        } else if (waitingForLoadMore) {
          waitingForLoadMore = false;
          console.log('No new reviews yet after load more click, waiting one more cycle...');
        } else {
          consecutiveNoChange++;
          console.log(`No new unique reviews loaded (${consecutiveNoChange}/10)`);
        }

        lastUniqueReviewCount = newUniqueReviewCount;

        if (scrollCount >= 100 || consecutiveNoChange >= 10) {
          console.log(`Finished scrolling. Total unique reviews seen: ${newUniqueReviewCount}`);
          setTimeout(resolve, 4000);
        }
      }, 1500);

      if (scrollCount < 100 && consecutiveNoChange < 10) {
        setTimeout(performScroll, 1500);
      }
    };

    setTimeout(performScroll, 1000);
  });
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

    reviewElements.forEach((reviewEl, index) => {
      const review = {
        text: '',
        rating: 'N/A',
        date: ''
      };

      // Extract review text - find the longest meaningful span
      const textSpans = reviewEl.querySelectorAll('span');
      review.text = selectBestReviewText(textSpans);

      // Extract date
      const datePatterns = [
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i,
        /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i,
        /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\b/i
      ];
      
      const allText = reviewEl.textContent;
      for (const pattern of datePatterns) {
        const match = allText.match(pattern);
        if (match) {
          review.date = match[0];
          break;
        }
      }

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
  let prompt = `Before you begin any analysis, ask me to clarify the must-have requirements for this trip (for example: minimum bedrooms, washer/dryer availability, budget range, accessibility needs, preferred neighbourhoods, or other deal-breakers). Wait for my response, then continue with the analysis below.

I'm analyzing ${propertiesData.length} Airbnb properties from my wishlist. I need you to carefully review each property's details and reviews, paying special attention to subtle hints and concerns that guests might mention even when giving high ratings. People often soften negative feedback or bury concerns in otherwise positive reviews, especially when the host is friendly.

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
    prompt += `**Overall Rating**: ${property.rating || 'N/A'} (${property.reviewCount || 0} reviews)\n\n`;
    
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