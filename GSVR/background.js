/* background.js (MV3 service worker)
 * Handles report-file downloads requested by the content script.
 */
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'GSVR_DOWNLOAD') {
    return;
  }
  (async () => {
    try {
      const filename = String(message.filename || `gsvr-export-${Date.now()}.txt`);
      const hasDataUrl = typeof message.dataUrl === 'string' && /^data:/i.test(message.dataUrl);
      const mimeType = String(message.mimeType || 'text/plain;charset=utf-8');
      const content = String(message.content || '');
      const url = hasDataUrl ? message.dataUrl : `data:${mimeType},${encodeURIComponent(content)}`;
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
      sendResponse({ ok: typeof downloadId === 'number', downloadId: downloadId ?? null });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) ? String(e.message) : 'download failed' });
    }
  })();
  return true;
});
