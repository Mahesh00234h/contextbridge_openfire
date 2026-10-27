/**
 * Offscreen document used only for clipboard writes from the service worker.
 * MV3 service workers have no DOM, so `navigator.clipboard` is unavailable
 * there; the offscreen document provides the required execution context.
 */
function copyWithSelection(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  let copied = false;
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }

  return copied;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.target !== 'offscreen') return false;
  if (request.type !== 'COPY_TO_CLIPBOARD') return false;

  const text = String(request.text || '');

  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => sendResponse({ ok: true, method: 'clipboard' }))
      .catch(() => sendResponse({ ok: copyWithSelection(text), method: 'execCommand' }));
  } else {
    sendResponse({ ok: copyWithSelection(text), method: 'execCommand' });
  }

  return true;
});