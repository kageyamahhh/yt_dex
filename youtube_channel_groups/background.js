// コンテンツスクリプトは chrome.runtime.openOptionsPage() を呼べないため、ここで代行する
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id === chrome.runtime.id && msg && msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
});
