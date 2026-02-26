/**
 * MV3 Service Worker
 * 职责：调用 chrome.tabs.captureVisibleTab 对当前 Tab 进行截图
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_TAB') {
    captureTab(message.tabId, message.windowId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function captureTab(tabId, windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'png',
      quality: 100,
    });
    return { dataUrl };
  } catch (err) {
    return { error: err.message };
  }
}
