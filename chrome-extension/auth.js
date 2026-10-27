/**
 * AI Context Bridge - Supabase Auth helper.
 *
 * The extension signs in directly against Supabase instead of scraping a
 * session out of a web-app tab. That keeps the extension self-contained and
 * removes the need for cookie access or host permissions on a dashboard origin.
 *
 * Session shape stored in chrome.storage.local under APP_CONFIG.authStorageKey:
 *   { access_token, refresh_token, expires_at, user: { id, email, user_metadata } }
 */
(function (global) {
  'use strict';

  const SUPABASE_URL = global.APP_CONFIG.supabaseUrl;
  const SUPABASE_ANON_KEY = global.APP_CONFIG.supabaseAnonKey;
  const STORAGE_KEY = global.APP_CONFIG.authStorageKey;
  const EXPIRY_BUFFER_SECONDS = 60;

  function normalizeSession(payload, fallbackUser) {
    if (!payload || !payload.access_token) return null;
    const expiresIn = Number(payload.expires_in) || 3600;
    const expiresAt =
      Number(payload.expires_at) || Math.floor(Date.now() / 1000) + expiresIn;
    const rawUser = payload.user || fallbackUser || null;

    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || null,
      expires_at: expiresAt,
      user: rawUser
        ? {
            id: rawUser.id,
            email: rawUser.email || null,
            user_metadata: rawUser.user_metadata || {},
          }
        : null,
    };
  }

  async function readSession() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      return stored[STORAGE_KEY] || null;
    } catch {
      return null;
    }
  }

  async function writeSession(session) {
    await chrome.storage.local.set({ [STORAGE_KEY]: session });
    return session;
  }

  async function clearSession() {
    await chrome.storage.local.remove([STORAGE_KEY]);
  }

  async function request(path, { method = 'POST', body, token, headers = {} } = {}) {
    const response = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const error = new Error(
        data?.error_description ||
          data?.msg ||
          data?.message ||
          data?.error ||
          `Request failed (${response.status})`,
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async function signIn(email, password) {
    const data = await request('/auth/v1/token?grant_type=password', {
      body: { email: String(email || '').trim(), password: String(password || '') },
    });
    const session = normalizeSession(data);
    if (!session) throw new Error('Sign-in did not return a session');
    return writeSession(session);
  }

  async function signUp(email, password, displayName) {
    const data = await request('/auth/v1/signup', {
      body: {
        email: String(email || '').trim(),
        password: String(password || ''),
        data: displayName ? { display_name: displayName } : undefined,
      },
    });

    if (!data?.access_token) {
      // Email confirmation is enabled for this project.
      return { requiresConfirmation: true, user: data?.user || null };
    }

    const session = normalizeSession(data);
    if (!session) throw new Error('Sign-up did not return a session');
    await writeSession(session);
    return { requiresConfirmation: false, ...session };
  }

  async function refresh(session) {
    if (!session?.refresh_token) {
      const error = new Error('Session expired, please sign in again');
      error.status = 401;
      throw error;
    }

    const data = await request('/auth/v1/token?grant_type=refresh_token', {
      body: { refresh_token: session.refresh_token },
    });
    const next = normalizeSession(data, session.user);
    if (!next) throw new Error('Refresh did not return a session');
    return writeSession(next);
  }

  async function getSession({ forceRefresh = false } = {}) {
    let session = await readSession();
    if (!session?.access_token) return null;

    const now = Math.floor(Date.now() / 1000);
    const expiresSoon =
      !session.expires_at || session.expires_at - now <= EXPIRY_BUFFER_SECONDS;

    if (forceRefresh || expiresSoon) {
      try {
        session = await refresh(session);
      } catch (error) {
        if (error.status === 400 || error.status === 401) {
          await clearSession();
        }
        return null;
      }
    }

    return session;
  }

  async function getAccessToken(options) {
    const session = await getSession(options);
    return session?.access_token || null;
  }

  async function getUser() {
    const session = await getSession();
    return session?.user || null;
  }

  async function signOut() {
    const session = await readSession();
    if (session?.access_token) {
      // Best-effort token revocation; local sign-out must always succeed.
      request('/auth/v1/logout', {
        method: 'POST',
        token: session.access_token,
      }).catch(() => {});
    }
    await clearSession();
  }

  global.AUTH = {
    signIn,
    signUp,
    signOut,
    getSession,
    getAccessToken,
    getUser,
    clearSession,
    readSession,
  };
})(typeof self !== 'undefined' ? self : window);