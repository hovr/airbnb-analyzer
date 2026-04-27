# Airbnb Analyzer

Airbnb Analyzer is a Chrome extension that gathers details and reviews from Airbnb wishlist properties or from a single Airbnb room/listing page. It scrolls each property’s review list, pulls the useful information into a single prompt, and makes it easy to feed that prompt into an AI assistant for deeper analysis.

## What you need before starting

- A computer with Google Chrome installed.
- An Airbnb account with at least one saved wishlist, or an Airbnb room/listing page you want to analyze directly.
- The extension files from this repository (downloaded to a folder on your computer).

## Step-by-step installation (for non-technical users)

1. **Download the extension files**
   - Click the green `Code` button in GitHub and choose `Download ZIP`.
   - When the download finishes, open the ZIP file and extract it to a folder you can find easily (once setup the folder needs to stay there for teh extension to work, don't delete it).

2. **Open Chrome’s extensions page**
   - Open Google Chrome.
   - In the address bar, type `chrome://extensions` and press Enter.

3. **Turn on Developer Mode**
   - On the extensions page, look for the toggle in the top-right corner labeled `Developer mode` and switch it on. New buttons will appear.

4. **Load the extension**
   - Click the `Load unpacked` button that appears after you enable Developer Mode.
   - In the file picker window, select the folder that contains the extension files you extracted earlier (the folder should include files such as `manifest.json`, `background.js`, and `popup.html`).
   - Click `Select Folder` (Windows) or `Open` (macOS).
   - The extension should now appear in your list of extensions, typically with the name “Airbnb Wishlist/Listing Analyzer”.

5. **Pin the extension icon (optional but helpful)**
   - Click the puzzle-piece icon in Chrome’s toolbar (top-right).
   - Find “Airbnb Wishlist/Listing Analyzer” in the list and click the pin icon next to it so the extension icon stays visible.

## How to update the extension

The extension checks this GitHub repository when you open the popup. If a newer version is available, you will see a notice at the top of the popup.

1. **Download the latest files**
   - Open this GitHub repository.
   - Click the green `Code` button and choose `Download ZIP`.
   - Extract the ZIP file.

2. **Replace your old extension folder**
   - Find the folder you originally loaded into Chrome.
   - Replace its contents with the newly extracted files, or delete the old folder and move the new extracted folder into the same place.
   - Keep the folder somewhere permanent. Chrome needs these files to stay on your computer.

3. **Reload the extension in Chrome**
   - Open `chrome://extensions`.
   - Find “Airbnb Wishlist/Listing Analyzer”.
   - Click the reload button on that extension card.
   - Open the extension popup again. The update notice should disappear once the loaded version matches the latest version.

If you loaded the new files into a different folder, remove the old extension from `chrome://extensions`, then use **Load unpacked** again and select the new folder.

## How to use the extension

1. **Open the Airbnb page you want to analyze**
   - To analyze multiple listings, visit `https://www.airbnb.com` (or `.co.uk`) and open the wishlist you want to analyze. Make sure all the properties you’re interested in are visible.
   - To analyze one listing, open an individual Airbnb room/listing page. The URL should include `/rooms/...`.

2. **Start the analyzer**
   - Click the Airbnb Wishlist/Listing Analyzer icon in the Chrome toolbar.
   - On a wishlist page the popup shows how many properties it found. Click **Start Analysis** to process the whole list.
   - On an individual room/listing page (`/rooms/...`) the popup shows that it is ready to analyze the current listing. Click **Start Analysis** to build a single-listing prompt using that page’s reviews, details, and amenities.
   - The extension opens **one** property tab at a time and must stay visible while it works. Do not switch that tab away or close it until the run finishes; doing so can interrupt review collection.
   - For wishlist analysis, the extension automatically collects details, scrolls through reviews, and then closes the property tab before moving to the next one. This may take several minutes depending on how many properties you have.
   - For single-listing analysis, it processes only the listing you started from and returns a prompt focused on that property.

3. **Copy the analysis prompt**
   - When the analysis is complete, the popup will display a success message and enable the **Copy Prompt** button.
   - Click **Copy Prompt** to place the generated text on your clipboard. You can paste this into your preferred AI assistant (for example, ChatGPT) to get a summarized review analysis.

4. **Re-run if needed**
   - To re-run the analysis on the same or another wishlist, return to the wishlist page, open the extension popup again, and click **Start Analysis**.
   - To analyze another individual listing, open that listing’s `/rooms/...` page and click **Start Analysis** again.
   - If you click **Reset Analyzer** in the popup, you’ll be asked whether to clear the cached data for the properties currently in view. Choose **Yes** if you want a completely fresh scrape (for example, after new reviews appear).

## Recent improvements you should know about

- **Smart caching & reset control** – The extension caches detailed property data to avoid reloading reviews unnecessarily. When you reset the analyzer, you’ll see a prompt asking whether to flush the cache for the wishlist you’re viewing, so you can decide between speed and freshness.
- **Clear tab labels** – While reviews load, each property tab automatically updates its browser tab label to show the property number and how many reviews have been processed (for example, `#3 12/15 reviews`). This makes it easy to see progress at a glance.
- **Icon state awareness** – The extension icon now turns monochrome and opens a simple “You need to be on an Airbnb wishlist or room page” message if you activate it outside an eligible Airbnb page. Head to a wishlist or `/rooms/...` listing to restore the full popup.
- **Single listing mode** – You can run the analyzer directly from an Airbnb room page to generate a focused prompt for just that listing, reusing the same review and amenity scraping pipeline.

## Troubleshooting tips

- **Extension not visible**: Make sure Developer Mode is still enabled on `chrome://extensions` and that the extension is toggled on.
- **“Analysis already in progress” message**: Wait until the current run finishes, or refresh the wishlist page if you think the previous run got stuck.
- **No properties found on a wishlist**: In some cases Airbnb may not have finished rendering the wishlist when the extension checks the page. Refresh the wishlist page and open the extension popup again; this normally fixes it.
- **Airbnb pages not loading**: The extension works on Airbnb wishlist pages and individual room/listing pages. Confirm the URL includes `/wishlists/` or `/rooms/`.

If you run into other issues, double-check that you extracted the full ZIP and loaded the folder containing `manifest.json`. You can remove the extension from `chrome://extensions` and load it again at any time.
