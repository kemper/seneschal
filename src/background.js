/**
 * background.js — a service worker that exists for exactly one reason.
 *
 * A content script cannot open the extension's own options page: it may not
 * call chrome.runtime.openOptionsPage(), and window.open() on a
 * chrome-extension:// URL is blocked from a page context. So the gear button
 * in the dock sends a message and this worker opens the page.
 *
 * Everything else the extension does happens in the content script.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "seneschal:open-options") {
    chrome.runtime.openOptionsPage();
  }
  // No response is sent, so the listener stays synchronous and the message
  // channel closes immediately.
});
