/**
 * This module enables analyzing the text content of webpages, including with
 * natural language processing methods. The module uses Mozilla Readability
 * in a content script to parse document title and content when possible. The
 * module provides infrastructure for implementing a machine learning
 * classifier, but leaves feature generation from document attributes and
 * model implementation to study authors (e.g., using TensorFlow.js, ONNX.js,
 * WebDNN, or sklearn-porter).
 * 
 * @see {@link https://github.com/mozilla/readability}
 * @see {@link https://www.tensorflow.org/js}
 * @see {@link https://github.com/microsoft/onnxjs}
 * @see {@link https://mil-tokyo.github.io/webdnn/}
 * @see {@link https://github.com/nok/sklearn-porter}
 * @module webScience.pageText
 */
import * as messaging from "./messaging.js";
import * as matching from "./matching.js";
import * as events from "./events.js";
import * as inline from "./inline.js";
import * as pageManager from "./pageManager.js";
import pageTextContentScript from "./content-scripts/pageText.content.js";

/**
 * Additional information about the page data event.
 * @typedef {Object} TextParsedDetails
 * @property {number} pageId - The ID for the page, unique across browsing sessions.
 * @property {string} url - The URL of the page, without any hash.
 * @property {string} title - The title of the document, parsed by Readability.
 * @property {string} content - The document text content as an HTML string, parsed by Readability.
 * @property {string} textContent - The document text content with HTML tags removed, parsed by Readability.
 * @property {boolean} privateWindow - Whether the page loaded in a private window.
 */

/**
 * @callback textParsedListener
 * @param {TextParsedDetails} details - Additional information about the page data event.
 */

/**
 * @typedef {Object} TextParsedListenerRecord
 * @property {matching.MatchPatternSet} matchPatternSet - The match patterns for the listener.
 * @property {boolean} privateWindows - Whether to notify the listener about pages in private windows.
 * @property {browser.contentScripts.RegisteredContentScript} contentScript - The content
 * script associated with the listener.
 */

/**
 * A map where each key is a listener function and each value is a record for that listener function.
 * @constant {Map<textParsedListener, TextParsedListenerRecord>}
 * @private
 */
const textParsedListeners = new Map();

/**
 * @callback TextParsedAddListener
 * @param {textParsedListener} listener - The listener to add.
 * @param {Object} options - Options for the listener.
 * @param {string[]} options.matchPatterns - The webpages where the listener should be notified about page text.
 * @param {boolean} [options.privateWindows=false] - Whether to notify the listener about pages in private windows.
 */

/**
 * @callback TextParsedRemoveListener
 * @param {textParsedListener} listener - The listener to remove.
 */

/**
 * @callback TextParsedHasListener
 * @param {textParsedListener} listener - The listener to check.
 * @returns {boolean} Whether the listener has been added for the event.
 */

/**
 * @callback TextParsedHasAnyListeners
 * @returns {boolean} Whether the event has any listeners.
 */

/**
 * @typedef {Object} TextParsedEvent
 * @property {TextParsedAddListener} addListener - Add a listener for page text.
 * @property {TextParsedRemoveListener} removeListener - Remove a listener for page text.
 * @property {TextParsedHasListener} hasListener - Whether a specified listener has been added.
 * @property {TextParsedHasAnyListeners} hasAnyListeners - Whether the event has any listeners.
 */

/**
 * An event that fires when a page's text content has been parsed with Readability.
 * @constant {TextParsedEvent}
 */
export const onTextParsed = events.createEvent({
    name: "webScience.pageText.onTextParsed",
    addListenerCallback: addListener,
    removeListenerCallback: removeListener,
    notifyListenersCallback: () => { return false; }
});

/**
 * Whether the module has completed initialization.
 * @type{boolean}
 * @private
 */
let initialized = false;

/**
 * A callback function for adding a text parsed listener.
 * @param {pageDataCallback} listener - The listener function being added.
 * @param {Object} options - Options for the listener.
 * @param {string[]} options.matchPatterns - The match patterns for pages where the listener should
 * be notified.
 * @param {boolean} [options.privateWindows=false] - Whether the listener should be notified for
 * pages in private windows.
 * @private
 */
async function addListener(listener, {
    matchPatterns,
    privateWindows = false
}) {
    // Initialization
    if (!initialized) {
        initialized = true;
        await pageManager.initialize();
        // Listen for content script messages
        messaging.onMessage.addListener(messageListener,
            {
                type: "webScience.pageText.parsedText",
                schema: {
                    pageId: "string",
                    url: "string",
                    title: "string",
                    content: "string",
                    textContent: "string",
                    privateWindow: "boolean"
                }
            });
        // Notify the content script when there is a new Readability status
        // for a page and the page URL matches at least one listener
        messaging.registerSchema("webScience.pageText.isArticle", {
            isArticle: "boolean"
        });
        browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if("isArticle" in changeInfo && "url" in tab) {
                // Test match patterns here rather than in the tabs.onUpdated
                // listener options so we don't have to manage multiple listeners
                // or remove and add the listener while events might be queued
                for (const listenerRecord of textParsedListeners.values()) {
                    if (listenerRecord.matchPatternSet.matches(tab.url)) {
                        messaging.sendMessageToTab(tabId, {
                            type: "webScience.pageText.isArticle",
                            isArticle: tab.isArticle
                        });
                        break;
                    }
                }
            }
        }, {
            urls: [ "<all_urls>" ],
            properties: [ "isArticle" ]
        });
    }

    // Compile the match patterns for the listener
    const matchPatternSet = matching.createMatchPatternSet(matchPatterns);
    // Register a content script for the listener
    const contentScript = await browser.contentScripts.register({
        matches: matchPatterns,
        js: [{
            code: inline.dataUrlToString(pageTextContentScript)
        }],
        runAt: "document_idle"
    });

    // Store a record for the listener
    textParsedListeners.set(listener, {
        matchPatternSet,
        contentScript,
        privateWindows
    });
}

/**
 * A callback function for removing a text parsed listener.
 * @param {pageDataCallback} listener - The listener that is being removed.
 * @private
 */
function removeListener(listener) {
    // If there is a record of the listener, unregister its content script
    // and delete the record
    const listenerRecord = textParsedListeners.get(listener);
    if (listenerRecord === undefined) {
        return;
    }
    listenerRecord.contentScript.unregister();
    textParsedListeners.delete(listener);
}

/**
 * A callback function for messages from the content script.
 * @param {TextParsedDetails} textParsedDetails - Details of the text parsed from the
 * page.
 * @private
 */
function messageListener(textParsedDetails) {
    // Remove the type string from the content script message
    delete textParsedDetails.type;

    // Notify listeners when the private window and match pattern requirements are met
    for (const [listener, listenerRecord] of textParsedListeners) {
        if ((!textParsedDetails.privateWindow || listenerRecord.privateWindows)
            && (listenerRecord.matchPatternSet.matches(textParsedDetails.url))) {
            listener(textParsedDetails);
        }
    }
}
