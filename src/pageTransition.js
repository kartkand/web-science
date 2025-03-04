/**
 * This module enables observing webpage transitions, synthesizing a range of
 * transition data that may be valuable for browser-based studies. See the
 * `onPageTransitionData` event for details.
 * 
 * # Types of Page Transition Data
 * This module supports several types of page transition data. Some types are
 * supported and recommended, because the data is consistently available, has
 * consistent meaning, and reflects discrete categories of user interactions.
 * Other types of transition data are supported because they appear in prior
 * academic literature, but we  do not recommend them because of significant
 * limitations.
 *   * Supported and Recommended Types of Page Transition Data
 *     * WebExtensions Transitions - This module reports the same webpage
 *       transition data provided by the WebExtensions `webNavigation` API. There
 *       are two types of transition data: `TransitionType` (e.g., "link" or
 *       "typed") and `TransitionQualifier` (e.g., "from_address_bar" or
 *       "forward_back"). Note that Firefox's support for these values is mostly
 *       but not entirely complete and defaults to a "link" transition type. The 
 *       MDN documentation for Firefox's implementation is also currently out of
 *       date, see: https://github.com/mdn/browser-compat-data/issues/9019. We
 *       recommend checking click transition data to confirm whether the user
 *       clicked on a link.
 *     * Tab-based Transitions - This module reports the webpage that was
 *       previously loaded in a new webpage's tab. If the webpage is loading in a
 *       newly created tab, this module reports the webpage that was open in
 *       the opener tab. We recommend using tab-based transition data when the user
 *       has clicked a link (according to both WebExtensions and click data), when
 *       the user has navigated with forward and back buttons, and when the page
 *       has refreshed (due to user action or automatically). In these situations,
 *       there is a clear causal relationship between the previous and current
 *       pages. We do not otherwise recommend using tab-based transition data,
 *       because the user might be reusing a tab for reasons unrelated to the page
 *       loaded in the tab.
 *     * Click Transitions - This module reports when a click on a webpage is
 *       immediately followed by a new webpage loading in the same tab (or a
 *       newly opened tab were that tab is the opener). This activity indicates
 *       the user likely clicked a link, and it compensates for limitations in
 *       how browsers detect link clicks for the `webNavigation` API.
 *   * Supported But Not Recommended Types of Page Transition Data   
 *     * Referrers - This module reports the HTTP referrer for each new page. While
 *       referrers have long been a method for associating webpage loads with
 *       prior pages, they are not consistently available (webpages and browsers
 *       are increasingly limiting when referrers are sent), do not have consistent
 *       content (similarly, webpages and browsers are increasingly limiting
 *       referrers to just origins), and do not have consistent meaning (the rules
 *       for setting referrers are notoriously complex and can have nonintuitive
 *       semantics). Be especially careful with referrers for webpage loads via
 *       the History API---because there is no new document-level HTTP request, the
 *       referrer will not change when the URL changes.
 *     * Time-based Transitions - This module reports the most recent webpage that
 *       loaded in any tab. We do not recommend relying on this data, because a
 *       chronological ordering of webpage loads may have no relation to user
 *       activity or perception (e.g., a webpage might automatically reload in the
 *       background before a user navigates to a new page).
 *  
 * # Page Transition Data Sources
 * This module builds on the page tracking provided by the `pageManager`
 * module and uses browser events, DOM events, and a set of heuristics to
 * associate transition information with each page visit. The module relies on
 * the following sources of data about page transitions, in addition to the
 * page visit tracking, attention tracking, and URL normalization provided by
 * `pageManager`:
 *   * Background Script Data Sources
 *     * `webNavigation.onCommitted` - provides tab ID, url,
 *       `webNavigation.TransitionType`, and `webNavigation.TransitionQualifier`
 *       values when a new page is loading in a tab.
 *     * `webNavigation.onDOMContentLoaded` - provides tab ID, url, and a
 *       timestamp approximating when the `DOMContentLoaded` event fired on a
 *       page.
 *     * `webNavigation.onHistoryStateUpdated` - provides tab ID, url,
 *       `webNavigation.TransitionType`, and `webNavigation.TransitionQualifier`
 *       values when a new page loads in a tab via the History API.
 *     * `webNavigation.onCreatedNavigationTarget` - provides tab ID, source
 *       tab ID, and url when a page loads in a tab newly created by another
 *       tab. Because of a regression, this event does not currently fire
 *       in Firefox for a click on a link with the target="_blank" attribute.
 *     * `tabs.onCreated` - provides tab ID and source tab ID when a page
 *       loads in a tab newly created by another tab, except if the new
 *       tab is in a different window.
 *   * Content Script Data Sources
 *     * The `click` event on the `document` element - detects possible link
 *       clicks via the mouse (e.g., left click).
 *     * The `contextmenu` event on the `document` element - detects possible
 *       link clicks via the mouse (e.g., right click or control + click).
 *     * The `keyup` event on the document element - detects possible link
 *       clicks via the keyboard.
 * 
 * # Combining Data Sources into a Page Transition
 * Merging these data sources into a page transition event poses several
 * challenges.
 *   * We have to sync background script `webNavigation` events with content
 *     scripts. As with `pageManager`, we have to account for the possibility
 *     of race conditions between the background script and content script
 *     environments. We use the same general approach in this module as in
 *     `pageManager`, converting background script events into messages posted
 *     to content scripts. We have to be a bit more careful about race
 *     conditions than in `pageManager`, though, because if a tab property
 *     event handled in that module goes to the wrong content script the
 *     consequences are minimal (because correct event data will quickly
 *     arrive afterward). In this module, by contrast, an error could mean 
 *     incorrectly associating a pair of pages. We further account for the
 *     possibility of race conditions by matching the `webNavigation` URL and
 *     DOMContentLoaded timestamp with the content script's URL and
 *     DOMContentLoaded timestamp.
 *   * We have to sync background script `webNavigation` events for different
 *     stages in the webpage loading lifecycle, because we want properties of
 *     both `webNavigation.onCommitted` and `webNavigation.onDOMContentLoaded`:
 *     the former has transition types and qualifiers, while the latter has a
 *     timestamp that is comparable to an event in the content script and does
 *     not have the risk of firing before the content script is ready to
 *     receive messages. Unlike `webRequest` events, `webNavigation` events are
 *     not associated with unique identifiers. We accomplish syncing across
 *     events by assuming that when the `webNavigation.onDOMContentLoaded` event
 *     fires for a tab, it is part of the same navigation lifecycle as the most
 *     recent `webNavigation.onCommitted` event in the tab.
 *   * We have to sync content script data for a page with content script
 *     data for a prior page (either loaded in the same tab, loaded in an
 *     opener tab, or loaded immediately before in time). We accomplish this for
 *     ordinary page loads by maintaining a cache of page visit data in the
 *     in the background script. We accomplish this for History API page loads
 *     by passing information in the content script environment.
 *   * We have to account for a regression in Firefox where
 *     `webNavigation.onCreatedNavigationTarget` does not currently fire for
 *     a click on a link with the target="_blank" attribute. We accomplish this
 *     by using `tabs.onCreated` event data when
 *     `webNavigation.onCreatedNavigationTarget` event data is not available.
 *  
 * @see {@link https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation/onCommitted}
 * @see {@link https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation/TransitionType}
 * @see {@link https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation/TransitionQualifier}
 * @see {@link https://github.com/mdn/browser-compat-data/issues/9019}
 * @see {@link https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onCreated}
 * @module webScience.pageTransition
 */

import * as events from "./events.js";
import * as permissions from "./permissions.js";
import * as messaging from "./messaging.js";
import * as matching from "./matching.js";
import * as inline from "./inline.js";
import * as pageManager from "./pageManager.js";
import pageTransitionEventContentScript from "./content-scripts/pageTransition.event.content.js";
import pageTransitionClickContentScript from "./content-scripts/pageTransition.click.content.js";
 
permissions.check({
    module: "webScience.pageTransition",
    requiredPermissions: [ "webNavigation" ],
    suggestedOrigins: [ "<all_urls>" ]
});

/**
 * The details of a page transition data event.
 * @typedef {Object} PageTransitionDataDetails
 * @property {string} pageId - The ID for the page, unique across browsing sessions.
 * @property {string} url - The URL of the page, without any hash.
 * @property {string} referrer - The referrer URL for the page, or `""` if there is no referrer. Note that we
 * recommend against using referrers for analyzing page transitions.
 * @property {number} tabId - The ID for the tab containing the page, unique to the browsing session. Note that if
 * you send a message to the content script in the tab, there is a possible race condition where the page in 
 * the tab changes before your message arrives. You should specify a page ID (e.g., `pageId`) in your message to the
 * content script, and the content script should check that page ID against its current page ID to ensure that the 
 * message was received by the intended page.
 * @property {boolean} isHistoryChange - Whether the page transition was caused by a URL change via the History API.
 * @property {boolean} isOpenedTab - Whether the page is loading in a tab that was newly opened from another tab.
 * @property {number} openerTabId - If the page is loading in a tab that was newly opened from another tab
 * (i.e., `isOpenedTab` is `true`), the tab ID of the opener tab. Otherwise, `tabs.TAB_ID_NONE`. Note that if
 * you send a message to the content script in the tab, there is a possible race condition where the page in 
 * the tab changes before your message arrives. You should specify a page ID (e.g., `tabSourcePageId`) in your
 * message to the content script, and the content script should check that page ID against its current page ID to
 * ensure that the message was received by the intended page.
 * @property {string} transitionType - The transition type, from `webNavigation.onCommitted` or
 * `webNavigation.onHistoryStateUpdated`.
 * @property {string[]} transitionQualifiers - The transition qualifiers, from `webNavigation.onCommitted` or
 * `webNavigation.onHistoryStateUpdated`.
 * @property {string} tabSourcePageId - The ID for the most recent page in the same tab. If the page is opening
 * in a new tab, then the ID of the most recent page in the opener tab. The value is `""` if there is no such page.
 * @property {string} tabSourceUrl - The URL, without any hash, for the most recent page in the same tab. If the page
 * is opening in a new tab, then the URL of the most recent page in the opener tab. The value is `""` if there is no
 * such page.
 * @property {boolean} tabSourceClick - Whether the user recently clicked or pressed enter/return on the most recent
 * page in the same tab. If the page is loading in a tab that was newly opened by another tab, then whether the user
 * recently clicked or pressed enter/return on the most recent page in the opener tab. The value is `false` if there
 * is no such page.
 * @property {string} timeSourcePageId - The ID for the most recent page that loaded into any tab. If this is the
 * first page visit after the extension starts, the value is "". Note that we recommend against using time-based
 * page transition data.
 * @property {string} timeSourceUrl - The URL for the most recent page that loaded into any tab. If this is the
 * first page visit after the extension starts, the value is "". Note that we recommend against using time-based
 * page transition data.
 */

/**
 * A callback function for the page transition data event.
 * @callback pageTransitionDataListener
 * @param {PageTransitionDataDetails} details - Additional information about the page transition data event.
 */

/**
 * @typedef {Object} PageTransitionDataOptions
 * @property {string[]} matchPatterns - Match patterns for pages where the listener should be notified about
 * transition data.
 * @property {boolean} [privateWindows=false] - Whether to notify the listener about page transitions in
 * private windows and whether to consider pages loaded in private windows when generating time-based
 * transition information.
 */

/**
 * @typedef {Object} PageTransitionDataListenerRecord
 * @property {matching.MatchPatternSet} matchPatternSet - Match patterns for pages where the listener should be
 * notified about transition data.
 * @property {boolean} privateWindows - Whether to notify the listener about page transitions in
 * private windows and whether to consider pages loaded in private windows when generating
 * time-based transition information.
 * @property {browser.contentScripts.RegisteredContentScript} contentScript - The content
 * script associated with the listener.
 */

/**
 * A map where each key is a listener function and each value is a record for that listener function.
 * @constant {Map<pageTransitionDataListener, PageTransitionDataListenerRecord>}
 * @private
 */
const pageTransitionDataListeners = new Map();

/**
 * @callback PageTransitionDataAddListener
 * @param {pageTransitionDataListener} listener - The listener to add.
 * @param {PageTransitionDataOptions} options - Options for the listener.
 */

/**
 * @callback PageTransitionDataRemoveListener
 * @param {pageTransitionDataListener} listener - The listener to remove.
 */

/**
 * @callback PageTransitionDataHasListener
 * @param {pageTransitionDataListener} listener - The listener to check.
 * @returns {boolean} Whether the listener has been added for the event.
 */

/**
 * @callback PageTransitionDataHasAnyListeners
 * @returns {boolean} Whether the event has any listeners.
 */

/**
 * @typedef {Object} PageTransitionDataEvent
 * @property {PageTransitionDataAddListener} addListener - Add a listener for page transition data.
 * @property {PageTransitionDataRemoveListener} removeListener - Remove a listener for page transition data.
 * @property {PageTransitionDataHasListener} hasListener - Whether a specified listener has been added.
 * @property {PageTransitionDataHasAnyListeners} hasAnyListeners - Whether the event has any listeners.
 */

/**
 * An event that fires when data about a page transition is available. The event will fire after
 * the pageManager.onPageVisitStart event, when DOM content has loaded (for ordinary page loads)
 * or just after the URL changes (for History API page loads).
 * @constant {PageTransitionDataEvent}
 */
export const onPageTransitionData = events.createEvent({
    name: "webScience.pageTransition.onPageTransitionData",
    addListenerCallback: addListener,
    removeListenerCallback: removeListener,
    notifyListenersCallback: () => { return false; }
});

/**
 * A callback function for adding a page transition data listener.
 * @param {pageTransitionDataListener} listener - The listener function being added.
 * @param {PageTransitionDataOptions} options - Options for the listener.
 * @private
 */
 async function addListener(listener, {
    matchPatterns,
    privateWindows = false
}) {
    await initialize();
    // Store a record for the listener
    pageTransitionDataListeners.set(listener, {
        // Compile the listener's match pattern set
        matchPatternSet: matching.createMatchPatternSet(matchPatterns),
        privateWindows,
        // Register the event content script with the listener's match patterns
        contentScript: await browser.contentScripts.register({
            matches: matchPatterns,
            js: [{
                code: inline.dataUrlToString(pageTransitionEventContentScript)
            }],
            runAt: "document_start"
        })
    });
}

/**
 * A callback function for removing a page transition data listener.
 * @param {pageTransitionDataListener} listener - The listener that is being removed.
 * @private
 */
function removeListener(listener) {
    const listenerRecord = pageTransitionDataListeners.get(listener);
    if(listenerRecord === undefined) {
        return;
    }
    listenerRecord.contentScript.unregister();
    pageTransitionDataListeners.delete(listenerRecord);
}

/**
 * Whether the module has been initialized.
 * @type {boolean}
 * @private
 */
let initialized = false;

/**
 * Initialize the module, registering event handlers and message schemas.
 * @private
 */
async function initialize() {
    if(initialized) {
        return;
    }
    initialized = true;

    await pageManager.initialize();

    // Register the click content script for all URLs permitted by the extension manifest
    await browser.contentScripts.register({
        matches: permissions.getManifestOriginMatchPatterns(),
        js: [{
            code: inline.dataUrlToString(pageTransitionClickContentScript)
        }],
        runAt: "document_start"
    });

    // When pageManager.onPageVisitStart fires...
    pageManager.onPageVisitStart.addListener(({ pageId, url, pageVisitStartTime, privateWindow, tabId }) => {
        // Add the page visit's page ID, URL, start time, and private window status to the time-based transition cache
        pageVisitTimeCache[pageId] = { url, pageVisitStartTime, privateWindow };

        // Add the page visit's tab ID, page ID, URL, and start time to the tab-based transition cache
        let cachedPageVisitsForTab = pageVisitTabCache.get(tabId);
        if(cachedPageVisitsForTab === undefined) {
            cachedPageVisitsForTab = { };
            pageVisitTabCache.set(tabId, cachedPageVisitsForTab);
        }
        cachedPageVisitsForTab[pageId] = { url, pageVisitStartTime, clickTimeStamps: [ ] };

        // We can't remove stale pages from the time-based and tab-based caches here, because otherwise we can
        // have a race condition where the most recent page in a cache (from pageManager.onPageVisitStart)
        // is the same page that's about to receive a message from the background script (because of
        // webNavigation.onDOMContentLoaded). In that situation, we might evict an older page from the cache
        // that was the correct page for time-based or tab-based transition information.
    });

    // When webNavigation.onCommitted fires, store the details in the per-tab onCommitted details cache
    browser.webNavigation.onCommitted.addListener(details => {
        // Ignore subframe navigation
        if(details.frameId !== 0) {
            return;
        }
        webNavigationOnCommittedCache.set(details.tabId, details);
    }, {
        url: [ { schemes: [ "http", "https" ] } ]
    });

    // When webNavigation.onDOMContentLoaded fires, pull the webNavigation.onCommitted
    // details from the per-tab cache, pull the opener tab details from the opener
    // tab cache (if any), and notify the content script
    browser.webNavigation.onDOMContentLoaded.addListener(details => {
        // Ignore subframe navigation
        if(details.frameId !== 0) {
            return;
        }

        // Get the cached webNavigation.onCommitted details and expire the cache
        const webNavigationOnCommittedDetails = webNavigationOnCommittedCache.get(details.tabId);
        if(webNavigationOnCommittedDetails === undefined) {
            return;
        }
        webNavigationOnCommittedCache.delete(details.tabId);

        // Confirm that the webNavigation.onCommitted URL matches the webNavigation.onDOMContentLoaded URL
        if(details.url !== webNavigationOnCommittedDetails.url) {
            return;
        }

        // Notify the content script
        sendUpdateToContentScript({
            tabId: details.tabId,
            url: details.url,
            timeStamp: details.timeStamp,
            transitionType: webNavigationOnCommittedDetails.transitionType,
            transitionQualifiers: webNavigationOnCommittedDetails.transitionQualifiers,
            isHistoryChange: false
        });
    }, {
        url: [ { schemes: [ "http", "https" ] } ]
    });

    // When webNavigation.onHistoryStateUpdated fires, notify the content script
    browser.webNavigation.onHistoryStateUpdated.addListener(details => {
        // Ignore subframe navigation
        if(details.frameId !== 0) {
            return;
        }

        // Notify the content script
        sendUpdateToContentScript({
            tabId: details.tabId,
            url: details.url,
            timeStamp: details.timeStamp,
            transitionType: details.transitionType,
            transitionQualifiers: details.transitionQualifiers,
            isHistoryChange: true
        });
    }, {
        url: [ { schemes: [ "http", "https" ] } ]
    });

    // Register the message schemas for background script updates
    messaging.registerSchema("webScience.pageTransition.backgroundScriptEventUpdate", {
        url: "string",
        timeStamp: "number",
        transitionType: "string",
        transitionQualifiers: "object",
        pageVisitTimeCache: "object",
        cachedPageVisitsForTab: "object",
        isHistoryChange: "boolean",
        isOpenedTab: "boolean",
        openerTabId: "number",
        tabOpeningTimeStamp: "number"
    });

    // When webNavigation.onCreatedNavigationTarget fires, update the the opener tab cache.
    // This event fires for all opened tabs regardless of window, except for a regression
    // since Firefox 65 where the event does not fire for tabs opened by clicking a link
    // with a target="_blank" attribute. See https://github.com/mdn/content/issues/4507.
    // We observe those tab openings tabs.onCreated, since the tabs are always in the same
    // window. We do not use the URL from webNavigation.onCreatedNavigationTarget, because
    // an HTTP redirect might change the URL before webNavigation.onCommitted and
    // webNavigation.onDOMContentLoaded fire.
    browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
        openerTabCache.set(details.tabId, {
            openerTabId: details.sourceTabId,
            timeStamp: details.timeStamp
        });
    }, {
        url: [ { schemes: [ "http", "https" ] } ]
    });

    // When tabs.onCreated fires, update the opener tab cache. This event fires for all opened
    // tabs in the same window, but not opened tabs in a new window. We observe tabs that open
    // in new windows with webNavigation.onCreatedNavigationTarget.
    browser.tabs.onCreated.addListener(tab => {
        // Ignore non-content tabs
        if(!("id" in tab) || (tab.id === browser.tabs.TAB_ID_NONE)) {
            return;
        }
        // Ignore tabs without content opener tabs
        if(!("openerTabId" in tab) || (tab.openerTabId === browser.tabs.TAB_ID_NONE)) {
            return;
        }
        // If we've already populated the opener tab cache for this tab with data from a more
        // detailed webNavigation.onCreatedNavigationTarget event, ignore this event
        if(openerTabCache.get(tab.id) !== undefined) {
            return;
        }
        openerTabCache.set(tab.id, {
            openerTabId: tab.openerTabId,
            timeStamp: Date.now()
        });
    });

    // When tabs.onRemoved fires, set a timeout to expire the tab-based transition information
    // and opener information for that tab
    browser.tabs.onRemoved.addListener(tabId => {
        setTimeout(() => {
            pageVisitTabCache.delete(tabId);
            openerTabCache.delete(tabId);
        }, tabRemovedExpiry);
    });

    // When the event content script sends an update message, notify the relevant listeners
    messaging.onMessage.addListener((eventUpdateMessage, sender) => {
        for(const [listener, listenerRecord] of pageTransitionDataListeners) {
            if(eventUpdateMessage.privateWindow && !listenerRecord.privateWindows) {
                continue;
            }
            if(listenerRecord.matchPatternSet.matches(eventUpdateMessage.url)) {
                listener({
                    pageId: eventUpdateMessage.pageId,
                    url: eventUpdateMessage.url,
                    referrer: eventUpdateMessage.referrer,
                    tabId: sender.tab.id,
                    isHistoryChange: eventUpdateMessage.isHistoryChange,
                    isOpenedTab: eventUpdateMessage.isOpenedTab,
                    openerTabId: eventUpdateMessage.openerTabId,
                    transitionType: eventUpdateMessage.transitionType,
                    transitionQualifiers: eventUpdateMessage.transitionQualifiers.slice(),
                    tabSourcePageId: eventUpdateMessage.tabSourcePageId,
                    tabSourceUrl: eventUpdateMessage.tabSourceUrl,
                    tabSourceClick: eventUpdateMessage.tabSourceClick,
                    timeSourcePageId: listenerRecord.privateWindows ? eventUpdateMessage.timeSourcePageId : eventUpdateMessage.timeSourceNonPrivatePageId,
                    timeSourceUrl: listenerRecord.privateWindows ? eventUpdateMessage.timeSourceUrl : eventUpdateMessage.timeSourceNonPrivateUrl
                });
            }
        }
    },
    {
        type: "webScience.pageTransition.contentScriptEventUpdate",
        schema: {
            pageId: "string",
            url: "string",
            isHistoryChange: "boolean",
            isOpenedTab: "boolean",
            openerTabId: "number",
            transitionType: "string",
            transitionQualifiers: "object",
            tabSourcePageId: "string",
            tabSourceUrl: "string",
            tabSourceClick: "boolean",
            timeSourcePageId: "string",
            timeSourceUrl: "string",
            timeSourceNonPrivatePageId: "string",
            timeSourceNonPrivateUrl: "string",
            privateWindow: "boolean"
        }
    });

    // When the click content script sends an update message, update the tab-based transition cache
    messaging.onMessage.addListener((clickUpdateMessage, sender) => {
        // There should be a tab ID associated with the message, but might as well make certain
        if(!("tab" in sender) || !("id" in sender.tab)) {
            return;
        }

        // Update the cached link clicks for the page
        const cachedPageVisitsForTab = pageVisitTabCache.get(sender.tab.id);
        if((cachedPageVisitsForTab === undefined) || !(clickUpdateMessage.pageId in cachedPageVisitsForTab)) {
            return;
        }
        cachedPageVisitsForTab[clickUpdateMessage.pageId].clickTimeStamps = cachedPageVisitsForTab[clickUpdateMessage.pageId].clickTimeStamps.concat(clickUpdateMessage.clickTimeStamps);
    },
    {
        type: "webScience.pageTransition.contentScriptClickUpdate",
        schema: {
            pageId: "string",
            clickTimeStamps: "object"
        }
    });
}

/**
 * A map where keys are tab IDs and values are the most recent `webNavigation.onCommitted`
 * details, removed from the map when a subsequent `webNavigation.onDOMContentLoaded` fires
 * for the tab.
 * @constant {Map<number, Object>}
 * @private
 */
const webNavigationOnCommittedCache = new Map();

/**
 * A map, represented as an object, where keys are page IDs and values are objects with
 * `pageVisitStartTime`, `url`, and `privateWindow` properties from `pageManager.onPageVisitStart`.
 * We use an object so that it can be easily serialized. The reason we maintain this cache
 * is to account for possible race conditions between when pages load in the content script
 * environment and when the background script environment learns about page loads.
 * @constant {Object}
 * @private
 */
const pageVisitTimeCache = { };

/**
 * The maximum time, in milliseconds, to consider a page visit in any tab as a possible most
 * recent page visit in the content script environment, even though it's not the most recent
 * page visit in the background script environment.
 * @constant {number}
 * @private
 */
const pageVisitTimeCacheExpiry = 1000;

/**
 * @typedef {Object} PageVisitCachedDetails
 * @property {number} pageVisitStartTime - The page visit start time from `pageManager`.
 * @property {string} url - The URL from `pageManager`.
 * @property {number[]} clickTimeStamps - Timestamps for recent clicks on the page, from
 * the module's click content script.
 * @private
 */

/**
 * A map where keys are tab IDs and values are maps, represented as objects, where keys
 * are page IDs and values are PageVisitCachedDetails objects.
 * @constant {Map<number, Object}
 * @private
 */
const pageVisitTabCache = new Map();

/**
 * The maximum time, in milliseconds, to consider a page visit in a specific tab as a possible
 * most recent page visit for that tab in the content script environment, even though it's not
 * the most recent page visit for that tab in the background script environment.
 * @constant {number}
 * @private
 */
const pageVisitTabCacheExpiry = 5000;

/**
 * The maximum time, in milliseconds, to consider a click on a page as a possible most recent
 * click on the page in the content script environment, even though it's not the most recent
 * click in the background script environment.
 * @constant {number}
 * @private
 */
const clickCacheExpiry = 5000;

/**
 * The minimum time, in milliseconds, to wait after a tab is removed before expiring the cache
 * of page visits in that tab for tab-based transition information and the cached opener tab
 * for that tab.
 */
const tabRemovedExpiry = 10000;

/**
 * A map where keys are tab IDs and values are objects with `openerTabId` and `timeStamp`
 * properties.
 * @constant {Map<number, Object>}
 * @private
 */
const openerTabCache = new Map();

/**
 * Send an update to the content script running on a page, called when a
 * `webNavigation.onDOMContentLoaded` or `webNavigation.onHistoryStateUpdated`
 * event fires.
 * @param {Object} details - Details for the update to the content script.
 * @param {number} details.tabId - The tab ID for the tab where the page is loading.
 * @param {string} details.url - The URL for the page.
 * @param {number} details.timeStamp - The timestamp for the page that is loading,
 * either from `webNavigation.onDOMContentLoaded` or `webNavigation.onHistoryStateUpdated`.
 * @param {string} details.transitionType - The transition type for the page that is loading,
 * `webNavigation.onDOMContentLoaded` or `webNavigation.onHistoryStateUpdated`.
 * @param {string[]} details.transitionQualifiers - The transition qualifiers for the page
 * that is loading, either from `webNavigation.onDOMContentLoaded` or
 * `webNavigation.onHistoryStateUpdated`.
 * @param {boolean} details.isHistoryChange - Whether the update was caused by
 * `webNavigation.onDOMContentLoaded` (`false`) or `webNavigation.onHistoryStateUpdated`
 * (`true`).
 * @private
 */
 function sendUpdateToContentScript({
    tabId,
    url,
    timeStamp,
    transitionType,
    transitionQualifiers,
    isHistoryChange
}) {
    // Retrieve cached page visits for this tab if this is not a History API change
    let cachedPageVisitsForTab = { };
    if(!isHistoryChange) {
        cachedPageVisitsForTab = pageVisitTabCache.get(tabId);
    }

    // Get the cached opener tab details if this is not a History API change
    let isOpenedTab = false;
    let openerTabId = browser.tabs.TAB_ID_NONE;
    let tabOpeningTimeStamp = 0;
    if(!isHistoryChange) {
        const openerTabDetails = openerTabCache.get(tabId);
        // If there are cached opener tab details, expire the cache and swap in the cached page
        // visits for the opener tab
        if(openerTabDetails !== undefined) {
            openerTabCache.delete(tabId);
            isOpenedTab = true;
            openerTabId = openerTabDetails.openerTabId;
            tabOpeningTimeStamp = openerTabDetails.timeStamp;
            cachedPageVisitsForTab = pageVisitTabCache.get(openerTabDetails.openerTabId);
        }
    }

    // Send a message to the content script with transition information. The content script will
    // merge this information with its local information to generate a PageTransitionData event.
    messaging.sendMessageToTab(tabId, {
        type: "webScience.pageTransition.backgroundScriptEventUpdate",
        url,
        timeStamp,
        transitionType,
        transitionQualifiers,
        isHistoryChange,
        pageVisitTimeCache,
        cachedPageVisitsForTab: (cachedPageVisitsForTab !== undefined) ? cachedPageVisitsForTab : { },
        isOpenedTab,
        openerTabId,
        tabOpeningTimeStamp
    });

    // Remove stale page visits from the time-based transition cache, retaining the most recent page
    // visit in any window and the most recent page visit in only non-private windows. We have to
    // track the most recent non-private page separately, since a listener might only be registered
    // for transitions involving non-private pages. We perform this expiration after sending a
    // message to the content script, for the reasons explained in the pageManager.onPageVisitStart
    // listener.
    const nowTimeStamp = Date.now();
    const expiredCachePageIds = new Set();
    let mostRecentPageId = "";
    let mostRecentPageVisitStartTime = 0;
    let mostRecentNonPrivatePageId = "";
    let mostRecentNonPrivatePageVisitStartTime = 0;
    for(const cachePageId in pageVisitTimeCache) {
        if(pageVisitTimeCache[cachePageId].pageVisitStartTime > mostRecentPageVisitStartTime) {
            mostRecentPageId = cachePageId;
            mostRecentPageVisitStartTime = pageVisitTimeCache[cachePageId].pageVisitStartTime;
        }
        if(!pageVisitTimeCache[cachePageId].privateWindow && (pageVisitTimeCache[cachePageId].pageVisitStartTime > mostRecentNonPrivatePageVisitStartTime)) {
            mostRecentNonPrivatePageId = cachePageId;
            mostRecentNonPrivatePageVisitStartTime = pageVisitTimeCache[cachePageId].pageVisitStartTime;
        }
        if((nowTimeStamp - pageVisitTimeCache[cachePageId].pageVisitStartTime) > pageVisitTimeCacheExpiry) {
            expiredCachePageIds.add(cachePageId);
        }
    }
    expiredCachePageIds.delete(mostRecentPageId);
    expiredCachePageIds.delete(mostRecentNonPrivatePageId);
    for(const expiredCachePageId of expiredCachePageIds) {
        delete pageVisitTimeCache[expiredCachePageId];
    }

    // Remove stale page visits and clicks from the tab-based transition cache. We don't have to
    // handle private and non-private windows separately, because if a tab precedes another tab
    // we know they have the same private window status.
    if(cachedPageVisitsForTab !== undefined) {
        // Expire stale pages, expect for the most recent page if it's also stale
        mostRecentPageId = "";
        mostRecentPageVisitStartTime = 0;
        expiredCachePageIds.clear();
        for(const cachePageId in cachedPageVisitsForTab) {
            if(cachedPageVisitsForTab[cachePageId].pageVisitStartTime > mostRecentPageVisitStartTime) {
                mostRecentPageId = cachePageId;
                mostRecentPageVisitStartTime = cachedPageVisitsForTab[cachePageId].pageVisitStartTime;
            }
            if((nowTimeStamp - cachedPageVisitsForTab[cachePageId].pageVisitStartTime) > pageVisitTabCacheExpiry) {
                expiredCachePageIds.add(cachePageId);
            }
        }
        expiredCachePageIds.delete(mostRecentPageId);
        for(const expiredCachePageId of expiredCachePageIds) {
            delete cachedPageVisitsForTab[expiredCachePageId];
        }

        // Expire stale clicks on the remaining pages, except for the most recent click if it's
        // also stale
        for(const cachePageId in cachedPageVisitsForTab) {
            let mostRecentClickOnPage = 0;
            const clickTimeStamps = [ ];
            for(const clickTimeStamp of cachedPageVisitsForTab[cachePageId].clickTimeStamps) {
                if((nowTimeStamp - clickTimeStamp) <= clickCacheExpiry) {
                    clickTimeStamps.push(clickTimeStamp);
                }
                mostRecentClickOnPage = Math.max(mostRecentClickOnPage, clickTimeStamp);
            }
            if((clickTimeStamps.length === 0) && (mostRecentClickOnPage > 0)) {
                clickTimeStamps.push(mostRecentClickOnPage);
            }
            cachedPageVisitsForTab[cachePageId].clickTimeStamps = clickTimeStamps;
        }
    }
}
