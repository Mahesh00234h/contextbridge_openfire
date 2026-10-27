/**
 * AI Context Bridge - content script.
 *
 * Runs on supported AI chat platforms and does three things:
 *   1. Extracts the visible conversation as a role-labelled transcript.
 *   2. Injects context into the composer in a way React/ProseMirror notices.
 *   3. Reports content changes so the service worker can debounce captures.
 */
console.log('AI Context Bridge: content script loaded');

const PLATFORM_CONFIG = {
  ChatGPT: {
    hosts: ['chatgpt.com', 'chat.openai.com'],
    messages: ['[data-message-author-role]'],
    inputs: ['#prompt-textarea', 'textarea[data-id="root"]', 'div[contenteditable="true"]'],
  },
  Claude: {
    hosts: ['claude.ai'],
    messages: [
      '[data-testid="conversation-turn"]',
      '[data-testid="user-message"]',
      '.font-claude-message',
    ],
    inputs: ['div[contenteditable="true"].ProseMirror', 'fieldset div[contenteditable="true"]'],
  },
  Gemini: {
    hosts: ['gemini.google.com'],
    messages: ['user-query', 'model-response'],
    inputs: ['rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
  },
  Copilot: {
    hosts: ['copilot.microsoft.com'],
    messages: ['[data-content="user-message"]', '[data-content="ai-message"]', '[data-testid="conversation-turn"]'],
    inputs: ['textarea', 'div[contenteditable="true"]'],
  },
  Poe: {
    hosts: ['poe.com'],
    messages: ['[class*="ChatMessage"]', '[class*="Message_bubble"]', '[data-testid^="message"]'],
    inputs: ['textarea', 'div[contenteditable="true"]'],
  },
  Perplexity: {
    hosts: ['perplexity.ai', 'www.perplexity.ai'],
    messages: ['[data-testid="copilot-answer"]', 'div.prose', '[class*="Answer"]'],
    inputs: ['textarea', 'div[contenteditable="true"]'],
  },
};

const GENERIC_INPUT_SELECTORS = [
  '#prompt-textarea',
  'textarea[placeholder]',
  'div[contenteditable="true"]',
  'textarea',
];

const UI_NOISE = [
  'how can i help',
  'start a new chat',
  'enter a prompt',
  'type a message',
  'message chatgpt',
  'ask anything',
];

function isExtensionValid() {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function detectPlatform() {
  const hostname = window.location.hostname.replace(/^www\./, '');
  for (const [name, config] of Object.entries(PLATFORM_CONFIG)) {
    if (config.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      return name;
    }
  }
  return null;
}

function safeSendMessage(message) {
  if (!isExtensionValid()) return Promise.resolve(null);
  try {
    return chrome.runtime.sendMessage(message).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

function detectRole(node) {
  const attrRole = (
    node.getAttribute?.('data-message-author-role') ||
    node.getAttribute?.('data-author') ||
    node.getAttribute?.('data-content') ||
    ''
  ).toLowerCase();

  if (/user|human|query/.test(attrRole)) return 'User';
  if (/assistant|ai|bot|model|answer/.test(attrRole)) return 'Assistant';

  const tag = node.tagName?.toLowerCase();
  if (tag === 'user-query') return 'User';
  if (tag === 'model-response') return 'Assistant';

  const classText = `${node.className || ''} ${node.parentElement?.className || ''}`.toLowerCase();
  if (/user|human|query/.test(classText)) return 'User';
  if (/assistant|bot|model|response|answer/.test(classText)) return 'Assistant';

  return 'Message';
}

function pickMessages(config) {
  for (const selector of config.messages) {
    let nodes;
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    if (!nodes.length) continue;

    // Drop nodes that contain another match, otherwise nested DOM wrappers
    // duplicate the same message text several times.
    const outermost = nodes.filter(
      (node) => !nodes.some((other) => other !== node && node.contains(other)),
    );

    const messages = [];
    for (const [index, node] of outermost.entries()) {
      const text = (node.innerText || '').trim();
      if (text.length < 2) continue;
      const role = detectRole(node);
      messages.push({
        role: role === 'Message' ? (index % 2 === 0 ? 'User' : 'Assistant') : role,
        text,
      });
    }

    if (messages.length) return messages;
  }
  return [];
}

function extractConversation(platform) {
  const config = platform ? PLATFORM_CONFIG[platform] : null;
  let messages = config ? pickMessages(config) : [];

  if (!messages.length) {
    // Last-resort fallback: platform-agnostic message containers. Kept
    // conservative so page chrome (sidebars, prompts) is not captured.
    const nodes = Array.from(
      document.querySelectorAll('[data-message], article, [class*="ChatMessage"]'),
    ).slice(-80);
    messages = nodes
      .map((node, index) => ({
        role: index % 2 === 0 ? 'User' : 'Assistant',
        text: (node.innerText || '').trim(),
      }))
      .filter((message) => message.text.length > 20);
  }

  const seen = new Set();
  const filtered = messages.filter(({ text }) => {
    const lower = text.toLowerCase();
    if (UI_NOISE.some((noise) => lower.includes(noise) && text.length < 120)) return false;
    const fingerprint = lower.replace(/\s+/g, ' ').slice(0, 400);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });

  if (!filtered.length) return '';

  return filtered.map(({ role, text }) => `${role}: ${text}`).join('\n\n---\n\n');
}

function getSelectionText() {
  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    if (
      typeof active.selectionStart === 'number' &&
      active.selectionStart !== active.selectionEnd
    ) {
      return active.value.slice(active.selectionStart, active.selectionEnd).trim();
    }
  }
  return (window.getSelection()?.toString() || '').trim();
}

function findComposer(platform) {
  const config = platform ? PLATFORM_CONFIG[platform] : null;
  const selectors = [...(config?.inputs || []), ...GENERIC_INPUT_SELECTORS];

  for (const selector of selectors) {
    let nodes;
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    const visible = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    });
    if (visible) return visible;
  }
  return null;
}

function setNativeValue(element, value) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

function injectContext(context) {
  if (!isExtensionValid()) return { success: false, reason: 'invalidated' };

  const platform = detectPlatform();
  const input = findComposer(platform);
  if (!input) return { success: false, reason: 'no_composer' };

  const text = String(context || '');
  input.focus();

  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      setNativeValue(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.setSelectionRange?.(text.length, text.length);
      return { success: true, method: 'value' };
    }

    const editableAttribute = input.getAttribute?.('contenteditable');
    const isEditable =
      input.isContentEditable || editableAttribute === 'true' || editableAttribute === '';

    if (isEditable) {
      // execCommand is deprecated but remains the most reliable way to make
      // React/ProseMirror composer state update with multi-line text.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);

      const inserted = document.execCommand('insertText', false, text);
      if (!inserted) {
        input.textContent = text;
      }
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }),
      );
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'contenteditable' };
    }
  } catch (error) {
    console.log('AI Context Bridge: injection failed', error?.message);
    return { success: false, reason: 'exception' };
  }

  return { success: false, reason: 'unsupported_input' };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!isExtensionValid()) return false;
  if (!request?.type) return false;

  try {
    if (request.type === 'GET_CONVERSATION') {
      const platform = detectPlatform();
      const text = extractConversation(platform);
      const messageCount = text
        ? text.split('\n\n---\n\n').filter((part) => part.trim().length > 0).length
        : 0;
      sendResponse({
        success: Boolean(text),
        text,
        platform,
        messageCount,
        title: document.title || '',
        url: window.location.href,
      });
      return false;
    }

    if (request.type === 'GET_SELECTION') {
      const text = getSelectionText();
      sendResponse({ success: Boolean(text), text, platform: detectPlatform() });
      return false;
    }

    if (request.type === 'INJECT_CONTEXT') {
      const result = injectContext(request.context);
      sendResponse(result);
      return false;
    }

    if (request.type === 'PING') {
      sendResponse({ pong: true, platform: detectPlatform() });
      return false;
    }
  } catch (error) {
    sendResponse({ success: false, error: String(error?.message || error) });
  }

  return false;
});

// ===== Change detection =====
let lastHash = '';
let debounceTimer = null;
let observer = null;
let lastUrl = window.location.href;

function hashContent(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return hash.toString();
}

function notifyChange() {
  if (!isExtensionValid()) {
    observer?.disconnect();
    observer = null;
    return;
  }

  const platform = detectPlatform();
  if (!platform) return;

  const content = extractConversation(platform);
  if (!content || content.length < 100) return;

  const hash = hashContent(content);
  if (hash === lastHash) return;
  lastHash = hash;

  safeSendMessage({
    type: 'CONTENT_UPDATED',
    platform,
    contentLength: content.length,
    url: window.location.href,
  });
}

function setupObserver() {
  if (!detectPlatform() || !isExtensionValid()) return;

  observer = new MutationObserver((mutations) => {
    if (!isExtensionValid()) {
      observer?.disconnect();
      observer = null;
      return;
    }

    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      lastHash = '';
    }

    if (mutations.some((mutation) => mutation.type === 'childList' && mutation.addedNodes.length)) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(notifyChange, 4000);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function watchNavigation() {
  // Most chat apps are SPAs and mutate history without firing popstate.
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      lastHash = '';
      if (!observer && isExtensionValid()) setupObserver();
    }
  }, 3000);
}

setTimeout(() => {
  setupObserver();
  watchNavigation();
}, 1500);

setTimeout(() => {
  if (!isExtensionValid()) return;
  const content = extractConversation(detectPlatform());
  if (content) lastHash = hashContent(content);
}, 2500);