/**
 * AI Context Bridge - background service worker.
 *
 * Responsibilities:
 *   - capture the visible conversation from supported AI platforms
 *   - structure it locally and (optionally) enrich it with cloud AI analysis
 *   - persist structured context locally, with raw text stored in Supabase
 *   - sync to Supabase with an authenticated user session and an offline queue
 *   - inject recalled context into the active tab, with a clipboard fallback
 *
 * Cloud writes are authenticated with the extension's own Supabase session
 * (see auth.js). The anonymous legacy tables are no longer written to: the
 * current database policies only allow authenticated owners.
 */
importScripts('config.js', 'auth.js');

const SUPABASE_URL = APP_CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = APP_CONFIG.supabaseAnonKey;
const CAPTURE_COOLDOWN = APP_CONFIG.captureCooldownMs;
const MAX_LOCAL_CONTEXTS = APP_CONFIG.maxLocalContexts;

const AI_PLATFORMS = {
  'chat.openai.com': 'ChatGPT',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'copilot.microsoft.com': 'Copilot',
  'poe.com': 'Poe',
  'perplexity.ai': 'Perplexity',
  'www.perplexity.ai': 'Perplexity',
};

const DEFAULT_SETTINGS = { autoCapture: true, cloudSync: true };
const BADGE_COLORS = {
  success: '#22c55e',
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#6366f1',
};

let lastCaptureTime = new Map();
const isAnalyzing = new Set();
let syncQueue = [];
let isSyncing = false;
let isOnline = true;
let syncProgress = { total: 0, completed: 0, current: null };

console.log('AI Context Bridge: background worker started');

// ===== SETTINGS & PROFILE =====

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings = stored.settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    cloudSync: settings.cloudSync ?? settings.useV2Ingest ?? DEFAULT_SETTINGS.cloudSync,
  };
}

async function getSession() {
  try {
    return await AUTH.getSession();
  } catch (error) {
    console.warn('AI Context Bridge: session lookup failed', error);
    return null;
  }
}

// ===== UTILITIES =====

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return String(url).split('?')[0].replace(/\/+$/, '');
  }
}

function normalizeMessageCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (value && typeof value === 'object') {
    return Math.max(0, (Number(value.user) || 0) + (Number(value.ai) || 0));
  }
  return 0;
}

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function detectPlatform(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return AI_PLATFORMS[hostname] || null;
  } catch {
    return null;
  }
}

function cleanTitle(title, platform) {
  if (!title) return null;
  const generic = ['new chat', 'untitled', 'chat', 'home', 'chatgpt', 'claude', 'gemini'];
  const lower = title.toLowerCase();
  if (generic.some((word) => lower === word)) return null;

  const cleaned = title
    .replace(/^(claude|chatgpt|gemini|copilot|poe|perplexity)\s*[-–—|:]\s*/i, '')
    .replace(/\s*[-–—|:]\s*(claude|chatgpt|gemini|copilot|poe|perplexity)$/i, '')
    .trim();

  return cleaned.length > 3 ? cleaned : null;
}

// ===== UI FEEDBACK =====

function updateBadge() {
  chrome.storage.local
    .get('capturedContexts')
    .then(({ capturedContexts = [] }) => {
      chrome.action.setBadgeText({ text: capturedContexts.length ? String(capturedContexts.length) : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
    })
    .catch(() => {});
}

function notifyUser(message, type = 'info', { silent = false } = {}) {
  console.log(`AI Context Bridge [${type}]: ${message}`);

  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[type] || BADGE_COLORS.info });
  chrome.action.setBadgeText({
    text: type === 'success' ? '✓' : type === 'error' ? '!' : '•',
  });
  setTimeout(updateBadge, 2000);

  if (!silent && chrome.notifications?.create) {
    try {
      chrome.notifications.create(`acb-${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'AI Context Bridge',
        message,
        priority: type === 'error' ? 2 : 0,
      });
    } catch (error) {
      console.warn('AI Context Bridge: notification failed', error);
    }
  }
}

// ===== CLIPBOARD (MV3 offscreen document) =====

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    return contexts.length > 0;
  }
  return Boolean(await chrome.offscreen?.hasDocument?.());
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  if (await hasOffscreenDocument()) return true;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy recalled context to the clipboard',
    });
    return true;
  } catch (error) {
    console.warn('AI Context Bridge: offscreen document failed', error);
    return false;
  }
}

async function copyToClipboard(text) {
  const ready = await ensureOffscreenDocument();
  if (ready) {
    try {
      const result = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'COPY_TO_CLIPBOARD',
        text,
      });
      if (result?.ok) return true;
    } catch (error) {
      console.warn('AI Context Bridge: offscreen clipboard failed', error);
    }
  }
  // The popup can finish the copy with navigator.clipboard when it is open.
  await chrome.storage.local.set({ pendingClipboard: text });
  return false;
}

// ===== TAB MESSAGING =====

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

async function injectIntoActiveTab(tabId, text) {
  if (!tabId) return false;
  const response = await sendToTab(tabId, { type: 'INJECT_CONTEXT', context: text });
  return Boolean(response?.success);
}

async function injectOrCopy(tabId, text, label = 'Context') {
  if (await injectIntoActiveTab(tabId, text)) {
    notifyUser(`${label} injected`, 'success', { silent: true });
    return true;
  }

  const copied = await copyToClipboard(text);
  notifyUser(
    copied
      ? `${label} copied to clipboard`
      : `${label} ready, but the browser blocked clipboard access`,
    copied ? 'success' : 'warning',
  );
  return copied;
}

// ===== OFFLINE QUEUE =====

function broadcastProgress() {
  chrome.runtime
    .sendMessage({
      type: 'SYNC_PROGRESS_UPDATE',
      progress: { ...syncProgress, queueLength: syncQueue.length },
    })
    .catch(() => {});
}

async function persistQueue() {
  await chrome.storage.local.set({ syncQueue });
}

async function hydrateQueue() {
  const stored = await chrome.storage.local.get(['syncQueue', 'captureCooldowns']);
  syncQueue = stored.syncQueue || [];
  if (stored.captureCooldowns) {
    for (const [key, timestamp] of Object.entries(stored.captureCooldowns)) {
      lastCaptureTime.set(key, timestamp);
    }
  }
}

async function enqueueMemory(item) {
  const key = item.threadKey || item.memoryId || item.localId;
  if (key) {
    syncQueue = syncQueue.filter((queued) => {
      if (queued.type !== item.type) return true;
      const queuedKey = queued.threadKey || queued.memoryId || queued.localId;
      return queuedKey !== key;
    });
  }

  syncQueue.push({ ...item, queuedAt: Date.now() });
  await persistQueue();
  broadcastProgress();

  if (!isSyncing) processSyncQueue();
}

async function cloudHeaders(session, extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function findCloudMemoryId(session, threadKey) {
  if (!threadKey) return null;
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/memories?select=id&source_thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`,
    { headers: await cloudHeaders(session) },
  );
  if (!response.ok) {
    const error = new Error(`Memory lookup failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const rows = await response.json();
  return rows?.[0]?.id || null;
}

async function upsertCloudMemory(session, item) {
  const payload = item.payload || {};
  const threadKey = item.threadKey || payload.source_thread_key;
  let memoryId = item.memoryId || null;

  if (!memoryId && threadKey) {
    memoryId = await findCloudMemoryId(session, threadKey);
  }

  const headers = await cloudHeaders(session, { Prefer: 'return=representation' });

  if (memoryId) {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?id=eq.${encodeURIComponent(memoryId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      const error = new Error(`Memory update failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const rows = await response.json().catch(() => []);
    return rows?.[0] || { id: memoryId };
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = new Error(`Memory create failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const rows = await response.json();
  return rows?.[0] || null;
}

async function deleteCloudMemory(session, memoryId) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/memories?id=eq.${encodeURIComponent(memoryId)}`,
    {
      method: 'DELETE',
      headers: await cloudHeaders(session),
    },
  );
  if (!response.ok && response.status !== 404) {
    const error = new Error(`Memory delete failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
}

async function markLocalContextSynced(item, saved) {
  const { capturedContexts = [] } = await chrome.storage.local.get('capturedContexts');
  const index = capturedContexts.findIndex((context) => {
    if (item.localId && context.id === item.localId) return true;
    return item.threadKey && normalizeUrl(context.url) === item.threadKey;
  });
  if (index === -1) return;

  capturedContexts[index] = {
    ...capturedContexts[index],
    memoryId: saved?.id || capturedContexts[index].memoryId || null,
    lastSyncedAt: Date.now(),
  };
  await chrome.storage.local.set({ capturedContexts });
  updateBadge();
}

async function processSyncQueue() {
  if (isSyncing || syncQueue.length === 0) return;

  const session = await getSession();
  if (!session?.access_token) return;

  isSyncing = true;
  syncProgress = { total: syncQueue.length, completed: 0, current: null };
  broadcastProgress();

  const queueCopy = [...syncQueue];
  const remaining = [];

  for (let i = 0; i < queueCopy.length; i++) {
    const item = queueCopy[i];
    syncProgress.current = item.payload?.title || item.threadKey || `Item ${i + 1}`;
    syncProgress.completed = i;
    broadcastProgress();

    const ownerId = item.payload?.user_id || item.ownerId || null;
    if (ownerId && ownerId !== session.user?.id) {
      console.warn('AI Context Bridge: dropping queued item from another account');
      continue;
    }

    try {
      if (item.type === 'delete') {
        await deleteCloudMemory(session, item.memoryId);
      } else {
        const saved = await upsertCloudMemory(session, item);
        await markLocalContextSynced(item, saved);
      }
      isOnline = true;
    } catch (error) {
      console.error('AI Context Bridge: sync item failed', error);

      if (error instanceof TypeError || error?.name === 'TypeError') {
        isOnline = false;
        remaining.push(...queueCopy.slice(i));
        break;
      }

      if (error.status === 401) {
        // Keep the item and everything after it; the next alarm retries after
        // the session refreshes.
        remaining.push(...queueCopy.slice(i));
        break;
      }

      if ([400, 403, 404].includes(error.status)) {
        // Permanent rejections (bad payload, RLS, or a deleted memory) will
        // never succeed, so drop them instead of retrying forever.
        console.warn('AI Context Bridge: dropping rejected queue item', error.status);
        continue;
      }

      remaining.push(item);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Preserve items queued while this run was in progress.
  const newlyQueued = syncQueue.filter((item) => !queueCopy.includes(item));
  syncQueue = remaining.concat(newlyQueued);
  await persistQueue();
  isSyncing = false;

  if (newlyQueued.length > 0) {
    setTimeout(() => processSyncQueue(), 1000);
  }

  syncProgress = { total: queueCopy.length, completed: queueCopy.length, current: null };
  broadcastProgress();
  setTimeout(() => {
    syncProgress = { total: 0, completed: 0, current: null };
    broadcastProgress();
  }, 2000);
}

// ===== CAPTURE PIPELINE =====

async function isCoolingDown(urlKey) {
  const now = Date.now();
  const inMemory = lastCaptureTime.get(urlKey) || 0;
  return now - inMemory < CAPTURE_COOLDOWN;
}

async function recordCapture(urlKey) {
  const now = Date.now();
  lastCaptureTime.set(urlKey, now);

  const stored = await chrome.storage.local.get('captureCooldowns');
  const cooldowns = stored.captureCooldowns || {};
  cooldowns[urlKey] = now;

  for (const key of Object.keys(cooldowns)) {
    if (now - cooldowns[key] > 86400000) delete cooldowns[key];
  }

  await chrome.storage.local.set({ captureCooldowns: cooldowns });
}

async function findExistingContext(url) {
  const { capturedContexts = [] } = await chrome.storage.local.get('capturedContexts');
  const normalized = normalizeUrl(url);
  return (
    capturedContexts.find(
      (context) => !context.threadKey && normalizeUrl(context.url) === normalized,
    ) || null
  );
}

async function saveLocalContext(context, { dedupeByUrl = true } = {}) {
  const { capturedContexts = [] } = await chrome.storage.local.get('capturedContexts');
  const localContext = { ...context };
  // Manual and selection captures keep their raw text locally; auto-captures
  // store it in the cloud copy only.
  if (localContext.type === 'auto') delete localContext.rawContent;

  const index = capturedContexts.findIndex((existing) => {
    if (existing.id === localContext.id) return true;
    if (localContext.threadKey && existing.threadKey === localContext.threadKey) return true;
    if (!dedupeByUrl) return false;
    // Selection/manual thread captures must not be overwritten by an
    // auto-capture of the surrounding conversation.
    if (existing.threadKey) return false;
    return normalizeUrl(existing.url) === normalizeUrl(localContext.url);
  });

  if (index !== -1) {
    capturedContexts[index] = { ...capturedContexts[index], ...localContext };
  } else {
    capturedContexts.unshift(localContext);
  }

  capturedContexts.sort((a, b) => {
    const aTime = Date.parse(a.lastUpdated || a.capturedAt || '') || a.timestamp || 0;
    const bTime = Date.parse(b.lastUpdated || b.capturedAt || '') || b.timestamp || 0;
    return bTime - aTime;
  });

  while (capturedContexts.length > MAX_LOCAL_CONTEXTS) capturedContexts.pop();

  await chrome.storage.local.set({ capturedContexts });
  updateBadge();
}

function memoryPayload(context, rawContent, userId, userEmail) {
  return {
    user_id: userId,
    title: context.title || 'Untitled Chat',
    topic: context.topic || null,
    summary: context.summary || null,
    key_points: Array.isArray(context.keyPoints) ? context.keyPoints : [],
    decisions: Array.isArray(context.decisions) ? context.decisions : [],
    open_questions: Array.isArray(context.openQuestions) ? context.openQuestions : [],
    raw_text: rawContent || null,
    source_platform: context.platform || null,
    source_url: context.url || null,
    source_thread_key: context.threadKey || normalizeUrl(context.url),
    source_page_title: context.pageTitle || null,
    source_captured_at: context.capturedAt || new Date().toISOString(),
    content_hash: context.contentHash || null,
    message_count: normalizeMessageCount(context.messageCount),
    captured_by_name: context.capturedByName || userEmail || null,
  };
}

async function analyzeWithAI(rawContent, platform, pageTitle, accessToken) {
  if (!accessToken) return null;

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/analyze-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ rawContent, platform, pageTitle }),
    });

    if (!response.ok) {
      console.warn('AI Context Bridge: analysis failed', response.status);
      return null;
    }

    const result = await response.json();
    if (!result?.success || !result.analysis) return null;
    return { ...result.analysis, messageCount: rawContent.split('\n\n---\n\n').length };
  } catch (error) {
    console.warn('AI Context Bridge: analysis error', error);
    return null;
  }
}

async function performCapture(tabId, url, platform, { force = false } = {}) {
  if (!tabId || !url || !platform) {
    return { success: false, reason: 'unsupported_page' };
  }

  const urlKey = normalizeUrl(url);

  if (!force) {
    if (isAnalyzing.has(urlKey)) return { success: false, reason: 'in_progress' };
    if (await isCoolingDown(urlKey)) return { success: false, reason: 'cooldown' };
  }

  isAnalyzing.add(urlKey);

  try {
    const conversation = await sendToTab(tabId, { type: 'GET_CONVERSATION' });
    if (!conversation?.text || conversation.text.trim().length < 50) {
      return { success: false, reason: 'no_conversation' };
    }

    const text = conversation.text.trim();
    if (text.split('\n').filter((line) => line.trim().length > 10).length < 2) {
      return { success: false, reason: 'too_short' };
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const pageTitle = tab?.title || conversation.title || '';
    const existing = await findExistingContext(url);
    const settings = await getSettings();
    const session = await getSession();

    const localAnalysis = generateDetailedContext(text, platform, pageTitle);
    let analysis = localAnalysis;

    if (session?.user?.id && settings.cloudSync) {
      const rich = await analyzeWithAI(text, platform, pageTitle, session.access_token);
      if (rich) analysis = { ...localAnalysis, ...rich };
    }

    const now = new Date().toISOString();
    const context = existing
      ? { ...existing }
      : {
          id: newId('ctx'),
          capturedAt: now,
          timestamp: Date.now(),
          type: 'auto',
        };

    Object.assign(context, {
      platform,
      url: tab?.url || url,
      pageTitle,
      title:
        analysis.title ||
        cleanTitle(pageTitle, platform) ||
        existing?.title ||
        'Untitled Chat',
      topic: analysis.topic || existing?.topic || '',
      summary: analysis.summary || existing?.summary || '',
      keyPoints: analysis.keyPoints?.length ? analysis.keyPoints : existing?.keyPoints || [],
      techStack: analysis.techStack?.length ? analysis.techStack : existing?.techStack || [],
      decisions: analysis.decisions?.length ? analysis.decisions : existing?.decisions || [],
      openQuestions: analysis.openQuestions?.length
        ? analysis.openQuestions
        : existing?.openQuestions || [],
      projectOrigin: analysis.projectOrigin || existing?.projectOrigin || '',
      coreInsights: analysis.coreInsights || existing?.coreInsights || '',
      whatHasBeenBuilt: analysis.whatHasBeenBuilt?.length
        ? analysis.whatHasBeenBuilt
        : existing?.whatHasBeenBuilt || [],
      strategicDirection: analysis.strategicDirection || existing?.strategicDirection || '',
      currentStatus: analysis.currentStatus || existing?.currentStatus || '',
      continuationPrompt: analysis.continuationPrompt || existing?.continuationPrompt || '',
      importantContext: analysis.importantContext || existing?.importantContext || '',
      messageCount: normalizeMessageCount(analysis.messageCount ?? localAnalysis.messageCount),
      contentHash: hashText(text),
      lastUpdated: now,
      aiAnalyzed: analysis !== localAnalysis,
      capturedByName:
        existing?.capturedByName ||
        session?.user?.user_metadata?.display_name ||
        session?.user?.email ||
        '',
    });

    await saveLocalContext(context);

    if (session?.user?.id && settings.cloudSync) {
      await enqueueMemory({
        type: 'upsert',
        threadKey: urlKey,
        localId: context.id,
        memoryId: existing?.memoryId || null,
        payload: memoryPayload(context, text, session.user.id, session.user.email),
      });
    }

    await recordCapture(urlKey);
    return { success: true, created: !existing, id: context.id };
  } catch (error) {
    console.error('AI Context Bridge: capture failed', error);
    return { success: false, reason: 'error', error: String(error?.message || error) };
  } finally {
    isAnalyzing.delete(urlKey);
  }
}

async function handleContentUpdate(tab, platform) {
  if (!tab?.id || !tab?.url) return { success: false, reason: 'no_tab' };

  const settings = await getSettings();
  if (!settings.autoCapture) return { success: false, reason: 'disabled' };

  return performCapture(tab.id, tab.url, detectPlatform(tab.url) || platform, {});
}

async function captureCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = detectPlatform(tab?.url);
  if (!tab?.id || !platform) return { success: false, reason: 'unsupported_page' };
  return performCapture(tab.id, tab.url, platform, {});
}

async function captureSelection(text, tab) {
  if (!text || !tab?.id || !tab?.url) return { success: false, reason: 'no_selection' };

  const platform = detectPlatform(tab.url) || 'Manual';
  const now = new Date().toISOString();
  const firstLine = text.trim().split('\n')[0].slice(0, 80);
  const threadKey = `${normalizeUrl(tab.url)}#selection-${hashText(text)}`;

  const context = {
    id: newId('ctx'),
    platform,
    url: tab.url,
    pageTitle: tab.title || '',
    title: `Selected: ${firstLine}`.slice(0, 90),
    topic: firstLine,
    summary: text.slice(0, 400),
    rawContent: text,
    keyPoints: [],
    techStack: [],
    decisions: [],
    openQuestions: [],
    messageCount: 1,
    capturedAt: now,
    timestamp: Date.now(),
    lastUpdated: now,
    contentHash: hashText(text),
    type: 'selection',
    threadKey,
  };

  await saveLocalContext(context, { dedupeByUrl: false });

  const session = await getSession();
  const settings = await getSettings();
  if (session?.user?.id && settings.cloudSync) {
    await enqueueMemory({
      type: 'upsert',
      threadKey,
      localId: context.id,
      payload: memoryPayload(context, text, session.user.id, session.user.email),
    });
  }

  return { success: true, id: context.id };
}

// ===== QUICK ACTIONS =====

function generateProjectPrompt(project) {
  if (!project) return '';
  const sections = ['You are continuing an existing project.', '', 'Context:'];
  if (project.goal) sections.push(`- Goal: ${project.goal}`);
  if (project.current_progress) sections.push(`- Current Progress: ${project.current_progress}`);
  if (project.constraints) sections.push(`- Constraints: ${project.constraints}`);
  if (project.tech_stack) sections.push(`- Tech Stack: ${project.tech_stack}`);
  if (project.notes) sections.push(`- Notes: ${project.notes}`);
  sections.push('', 'Do not ask onboarding questions.', 'Continue from this context.');
  return sections.join('\n');
}

async function handleQuickCapture(tab) {
  const platform = detectPlatform(tab?.url);
  if (!platform) {
    notifyUser('Open an AI chat to capture a conversation', 'info');
    return;
  }

  const result = await performCapture(tab.id, tab.url, platform, { force: true });
  if (result.success) {
    notifyUser(
      result.created
        ? `Captured from ${platform}`
        : `Updated the ${platform} capture`,
      'success',
    );
    return;
  }

  const messages = {
    no_conversation: 'No conversation found on this page yet',
    too_short: 'The conversation is too short to capture',
    unsupported_page: 'This page is not a supported AI chat',
    error: 'Capture failed, please try again',
  };
  notifyUser(messages[result.reason] || 'Nothing to capture', 'warning');
}

async function handleQuickRecall(tab) {
  const session = await getSession();
  if (!session) {
    notifyUser('Sign in from the extension to recall memories', 'warning');
    return;
  }

  const { activeProjectId } = await chrome.storage.local.get('activeProjectId');

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/recall-memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        query: '',
        projectId: isUuid(activeProjectId) ? activeProjectId : null,
        limit: 10,
        recencyDays: APP_CONFIG.defaultRecencyDays,
      }),
    });

    if (!response.ok) {
      notifyUser(`Recall failed (${response.status})`, 'error');
      return;
    }

    const result = await response.json();
    if (!result.count) {
      notifyUser('No memories found. Capture a chat first.', 'info');
      return;
    }

    await injectOrCopy(tab?.id, result.promptBlock, `${result.count} memories`);
  } catch (error) {
    console.error('AI Context Bridge: quick recall failed', error);
    notifyUser('Recall failed, please try again', 'error');
  }
}

async function handleQuickInject(tab) {
  const stored = await chrome.storage.local.get(['projects', 'activeProjectId']);
  const projects = stored.projects || [];
  const activeProjectId = stored.activeProjectId;

  if (!activeProjectId || projects.length === 0) {
    notifyUser('No active project. Create one in the extension first.', 'info');
    return;
  }

  const project = projects.find((candidate) => candidate.id === activeProjectId);
  if (!project) {
    notifyUser('Active project not found', 'error');
    return;
  }

  await injectOrCopy(tab?.id, generateProjectPrompt(project), 'Project context');
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  switch (command) {
    case 'quick-capture':
      await handleQuickCapture(tab);
      break;
    case 'quick-recall':
      await handleQuickRecall(tab);
      break;
    case 'quick-inject':
      await handleQuickInject(tab);
      break;
    default:
      break;
  }
});

// ===== CONTEXT MENU =====

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'capture-selection',
      title: 'Capture selection to AI Context Bridge',
      contexts: ['selection'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'capture-selection' || !info.selectionText) return;
  const result = await captureSelection(info.selectionText, tab);
  notifyUser(
    result.success ? 'Selection captured' : 'Could not capture the selection',
    result.success ? 'success' : 'error',
  );
});

// ===== MESSAGE ROUTER =====

async function deleteCapturedContext(id) {
  const stored = await chrome.storage.local.get('capturedContexts');
  const contexts = stored.capturedContexts || [];
  const context = contexts.find((candidate) => candidate.id === id);

  if (context?.memoryId) {
    const session = await getSession();
    if (session) {
      try {
        await deleteCloudMemory(session, context.memoryId);
      } catch (error) {
        await enqueueMemory({
          type: 'delete',
          memoryId: context.memoryId,
          ownerId: session.user?.id || null,
        });
      }
    }
  }

  await chrome.storage.local.set({
    capturedContexts: contexts.filter((candidate) => candidate.id !== id),
  });
  updateBadge();
  return { success: true };
}

const messageHandlers = {
  GET_CAPTURED_CONTEXTS: async () =>
    (await chrome.storage.local.get('capturedContexts')).capturedContexts || [],
  DELETE_CAPTURED_CONTEXT: async (request) => deleteCapturedContext(request.contextId),
  CAPTURE_CURRENT: async () => captureCurrentTab(),
  CONTENT_UPDATED: async (request, sender) =>
    handleContentUpdate(sender.tab, request.platform),
  GET_SYNC_STATUS: async () => ({
    isOnline,
    queueLength: syncQueue.length,
    syncProgress,
  }),
  PROCESS_SYNC_QUEUE: async () => {
    await processSyncQueue();
    return { success: true };
  },
  GET_AUTH_STATUS: async () => {
    const session = await getSession();
    return {
      signedIn: Boolean(session),
      user: session?.user || null,
      expiresAt: session?.expires_at || null,
    };
  },
  SIGN_OUT: async () => {
    await AUTH.signOut();
    return { success: true };
  },
  CAPTURE_SELECTION: async (request, sender) =>
    captureSelection(request.text, sender.tab),
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request?.type || !Object.prototype.hasOwnProperty.call(messageHandlers, request.type)) {
    return false;
  }

  Promise.resolve(messageHandlers[request.type](request, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ success: false, error: String(error?.message || error) }));

  return true;
});

// ===== LIFECYCLE =====

async function initialize() {
  await hydrateQueue();

  const settings = await getSettings();
  await chrome.storage.local.set({ settings });

  chrome.alarms.create('sync-retry', { periodInMinutes: 1 });
  chrome.alarms.create('session-refresh', { periodInMinutes: 15 });

  updateBadge();
  processSyncQueue();
}

chrome.runtime.onInstalled.addListener(async () => {
  createContextMenu();
  await initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync-retry') {
    await hydrateQueue();
    await processSyncQueue();
  }

  if (alarm.name === 'session-refresh') {
    const session = await getSession();
    if (session) {
      // A forced refresh keeps long-lived extension sessions working.
      await AUTH.getSession({ forceRefresh: true }).catch(() => null);
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.url) return;

  const platform = detectPlatform(tab.url);
  if (!platform) return;

  const settings = await getSettings();
  if (!settings.autoCapture) return;

  setTimeout(() => {
    performCapture(tabId, tab.url, platform, {});
  }, 2500);
});

initialize();

// ===== LOCAL HEURISTIC ANALYSIS =====

function generateDetailedContext(text, platform, pageTitle) {
  const lines = text.split('\n').filter((line) => line.trim());
  const messageCount = text.split('\n\n---\n\n').filter((part) => part.trim()).length;

  const techKeywords = [
    'React', 'Vue', 'Angular', 'Next.js', 'Node.js', 'TypeScript', 'JavaScript',
    'Python', 'PostgreSQL', 'MongoDB', 'Supabase', 'Firebase', 'AWS', 'Tailwind',
    'GraphQL', 'REST', 'Docker', 'Vite', 'Deno', 'Rust', 'Go', 'Java', 'Kotlin',
  ];

  const techStack = [
    ...new Set(
      text
        .split(/[\s,.\-()[\]{}:;'"\/\\]+/)
        .filter((word) => techKeywords.some((tech) => word.toLowerCase() === tech.toLowerCase())),
    ),
  ].slice(0, 10);

  const keyPoints = [];
  const decisions = [];
  const openQuestions = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      keyPoints.length < 5 &&
      ['key', 'important', 'must', 'should', 'requirement'].some((keyword) => lower.includes(keyword)) &&
      line.length > 20 &&
      line.length < 220
    ) {
      keyPoints.push(line.slice(0, 180));
    }

    if (
      decisions.length < 5 &&
      ['decided', 'will use', 'going with', 'chose', 'we use'].some((keyword) => lower.includes(keyword)) &&
      line.length > 15
    ) {
      decisions.push(line.slice(0, 180));
    }

    if (openQuestions.length < 5 && line.trim().endsWith('?') && line.length > 10) {
      openQuestions.push(line.slice(0, 180));
    }
  }

  let topic = cleanTitle(pageTitle, platform);
  if (!topic) {
    const firstUserLine = lines.find((line) => /^user:/i.test(line));
    const candidate = (firstUserLine || lines.find((line) => line.length > 10 && line.length < 100) || '')
      .replace(/^user:\s*/i, '')
      .trim();
    topic = candidate ? candidate.slice(0, 70) : 'Untitled Chat';
  }

  const summary =
    lines
      .filter((line) => line.length > 20 && !/^(user|assistant):/i.test(line))
      .slice(0, 3)
      .join(' ')
      .slice(0, 400) || `Conversation about ${topic}`;

  return {
    title: topic,
    topic,
    summary,
    keyPoints,
    techStack,
    decisions,
    openQuestions,
    messageCount,
  };
}