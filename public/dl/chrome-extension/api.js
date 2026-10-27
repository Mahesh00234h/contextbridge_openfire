/**
 * AI Context Bridge - API module.
 *
 * All cloud calls are authenticated with the extension's own Supabase session.
 * The old anonymous `captured_contexts` endpoints are intentionally not used:
 * current database policies only permit authenticated owners and team members.
 */
(function (global) {
  'use strict';

  const SUPABASE_URL = global.APP_CONFIG.supabaseUrl;
  const SUPABASE_ANON_KEY = global.APP_CONFIG.supabaseAnonKey;

  let cachedExtensionProfile = { userId: null, extensionUserId: null };
  let realtimeClose = null;

  function apiError(message, status, data) {
    const error = new Error(message);
    if (status) error.status = status;
    if (data) error.data = data;
    return error;
  }

  async function authRequest(path, { method = 'GET', body, prefer } = {}) {
    const session = await AUTH.getSession();
    if (!session?.access_token) {
      throw apiError('Sign in to use cloud features', 401);
    }

    const response = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
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
      throw apiError(
        data?.message || data?.error_description || data?.error || `Request failed (${response.status})`,
        response.status,
        data,
      );
    }

    return data;
  }

  async function currentUser() {
    const session = await AUTH.getSession();
    if (!session?.user?.id) throw apiError('Sign in to use cloud features', 401);
    return session.user;
  }

  async function currentAccessToken() {
    const session = await AUTH.getSession();
    if (!session?.access_token) throw apiError('Sign in to use cloud features', 401);
    return session.access_token;
  }

  function normalizeUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`;
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

  // ===== AUTH =====

  function signIn(email, password) {
    return AUTH.signIn(email, password);
  }

  function signUp(email, password, displayName) {
    return AUTH.signUp(email, password, displayName);
  }

  function signOut() {
    return AUTH.signOut();
  }

  function getSession(options) {
    return AUTH.getSession(options);
  }

  function getAccessToken(options) {
    return AUTH.getAccessToken(options);
  }

  // Kept as aliases for older popup code paths.
  function detectV2Session() {
    return AUTH.getSession();
  }

  function getV2Session(forceRefresh = false) {
    return AUTH.getSession({ forceRefresh });
  }

  // ===== CURRENT USER PROFILE =====

  async function getExtensionUserId(force = false) {
    const user = await currentUser();

    if (
      !force &&
      cachedExtensionProfile.userId === user.id &&
      cachedExtensionProfile.extensionUserId
    ) {
      return cachedExtensionProfile.extensionUserId;
    }

    const result = await authRequest('/rest/v1/rpc/current_extension_user_id', {
      method: 'POST',
      body: {},
    });

    const extensionUserId =
      typeof result === 'string'
        ? result
        : result?.current_extension_user_id || result?.current_extension_user_id?.[0] || null;

    if (!extensionUserId) {
      throw apiError('Your account profile is not ready yet. Try again in a moment.', 409);
    }

    cachedExtensionProfile = { userId: user.id, extensionUserId };
    return extensionUserId;
  }

  // ===== MEMORIES =====

  async function listMemories({ limit = 50, projectId = null } = {}) {
    const user = await currentUser();
    let query = `?select=*&user_id=eq.${user.id}&order=created_at.desc&limit=${limit}`;
    if (projectId) query += `&project_id=eq.${encodeURIComponent(projectId)}`;
    return (await authRequest(`/rest/v1/memories${query}`)) || [];
  }

  async function findMemoryByThread(threadKey) {
    if (!threadKey) return null;
    const rows = await authRequest(
      `/rest/v1/memories?select=id,source_thread_key&source_thread_key=eq.${encodeURIComponent(
        threadKey,
      )}&limit=1`,
    );
    return rows?.[0] || null;
  }

  async function createMemory(memory) {
    const rows = await authRequest('/rest/v1/memories', {
      method: 'POST',
      body: memory,
      prefer: 'return=representation',
    });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async function updateMemory(id, patch) {
    const rows = await authRequest(`/rest/v1/memories?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
      prefer: 'return=representation',
    });
    return Array.isArray(rows) ? rows[0] || { id } : rows;
  }

  async function getMemory(id) {
    const rows = await authRequest(
      `/rest/v1/memories?id=eq.${encodeURIComponent(id)}&select=*`,
    );
    return rows?.[0] || null;
  }

  async function upsertMemory(memory) {
    const user = await currentUser();
    const payload = { ...memory, user_id: memory.user_id || user.id };
    const existing = payload.source_thread_key
      ? await findMemoryByThread(payload.source_thread_key)
      : null;
    return existing?.id ? updateMemory(existing.id, payload) : createMemory(payload);
  }

  async function deleteMemory(id) {
    await authRequest(`/rest/v1/memories?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return true;
  }

  async function shareMemoryToTeam(memoryId, teamId) {
    return updateMemory(memoryId, { team_id: teamId });
  }

  async function getTeamMemories(teamId) {
    return (
      (await authRequest(
        `/rest/v1/memories?team_id=eq.${encodeURIComponent(teamId)}&select=*&order=created_at.desc`,
      )) || []
    );
  }

  // Backwards-compatible name used by the Team tab.
  const getTeamContexts = getTeamMemories;

  async function getMemoryRaw(id) {
    const memory = await getMemory(id);
    return memory?.raw_text || '';
  }

  /**
   * Upload local structured captures that have no cloud counterpart yet.
   * Raw text is not stored locally, so these memories are structure-only.
   */
  async function syncLocalContexts(contexts) {
    const user = await currentUser();
    const results = [];

    for (const context of contexts || []) {
      if (context.memoryId) continue;

      try {
        const saved = await upsertMemory({
          title: context.title || 'Untitled Chat',
          topic: context.topic || null,
          summary: context.summary || null,
          key_points: Array.isArray(context.keyPoints) ? context.keyPoints : [],
          decisions: Array.isArray(context.decisions) ? context.decisions : [],
          open_questions: Array.isArray(context.openQuestions) ? context.openQuestions : [],
          raw_text: context.rawContent || null,
          source_platform: context.platform || null,
          source_url: context.url || null,
          source_thread_key: normalizeUrl(context.url),
          source_page_title: context.pageTitle || null,
          source_captured_at:
            context.capturedAt || new Date(context.timestamp || Date.now()).toISOString(),
          content_hash: context.contentHash || null,
          message_count: normalizeMessageCount(context.messageCount),
          captured_by_name: context.capturedByName || user.email || null,
        });
        results.push({ id: context.id, memoryId: saved?.id || null, synced: true });
      } catch (error) {
        results.push({ id: context.id, synced: false, error: error.message });
      }
    }

    return results;
  }

  // ===== TEAMS =====

  async function createTeam(name) {
    const extensionUserId = await getExtensionUserId();
    const teams = await authRequest('/rest/v1/teams', {
      method: 'POST',
      body: { name: String(name || '').trim(), created_by: extensionUserId },
      prefer: 'return=representation',
    });
    const team = Array.isArray(teams) ? teams[0] : teams;
    if (!team?.id) throw apiError('Team creation failed', 500);

    await authRequest('/rest/v1/team_members', {
      method: 'POST',
      body: { team_id: team.id, user_id: extensionUserId },
      prefer: 'return=minimal',
    });

    return team;
  }

  /**
   * Joining by invite code needs a SECURITY DEFINER RPC because the `teams`
   * table is not readable until you are already a member.
   */
  async function joinTeam(inviteCode) {
    return authRequest('/rest/v1/rpc/join_team_by_invite', {
      method: 'POST',
      body: { invite_code: String(inviteCode || '').trim() },
    });
  }

  async function leaveTeam(teamId) {
    const extensionUserId = await getExtensionUserId();
    await authRequest(
      `/rest/v1/team_members?team_id=eq.${encodeURIComponent(
        teamId,
      )}&user_id=eq.${encodeURIComponent(extensionUserId)}`,
      { method: 'DELETE' },
    );
    return true;
  }

  async function getUserTeams() {
    const extensionUserId = await getExtensionUserId();
    const memberships =
      (await authRequest(
        `/rest/v1/team_members?user_id=eq.${encodeURIComponent(
          extensionUserId,
        )}&select=*,teams(*)`,
      )) || [];
    return memberships.map((membership) => membership.teams).filter(Boolean);
  }

  async function getTeamMembers(teamId) {
    return (
      (await authRequest(
        `/rest/v1/team_members?team_id=eq.${encodeURIComponent(
          teamId,
        )}&select=*,extension_users(name)`,
      )) || []
    );
  }

  async function getTeamSummaries(teamId) {
    return (
      (await authRequest(
        `/rest/v1/team_summaries?team_id=eq.${encodeURIComponent(
          teamId,
        )}&select=*&order=created_at.desc`,
      )) || []
    );
  }

  async function createTeamSummary(summary) {
    const extensionUserId = await getExtensionUserId();
    const rows = await authRequest('/rest/v1/team_summaries', {
      method: 'POST',
      body: { ...summary, created_by: summary.created_by || extensionUserId },
      prefer: 'return=representation',
    });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  // ===== EDGE FUNCTIONS =====

  async function recallMemory(options = {}) {
    const token = await currentAccessToken();
    const response = await fetch(`${SUPABASE_URL}/functions/v1/recall-memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: options.query || '',
        projectId: options.projectId || null,
        limit: options.limit || 10,
        recencyDays: options.recencyDays || global.APP_CONFIG.defaultRecencyDays,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw apiError(data?.error || `Recall failed (${response.status})`, response.status, data);
    }
    return data;
  }

  async function mergeTeamContext(teamId, sinceDays = 7) {
    const token = await currentAccessToken();
    const response = await fetch(`${SUPABASE_URL}/functions/v1/merge-team-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ teamId, sinceDays }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw apiError(
        data?.error || `Team merge failed (${response.status})`,
        response.status,
        data,
      );
    }
    return data;
  }

  /**
   * Legacy helper for users who still have an `extension_users` id from the
   * pre-auth version of the extension.
   */
  async function migrateUserData(legacyUserId, dryRun = false) {
    const token = await currentAccessToken();
    const response = await fetch(`${SUPABASE_URL}/functions/v1/migrate-user-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ legacyUserId, dryRun }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw apiError(
        data?.error || `Migration failed (${response.status})`,
        response.status,
        data,
      );
    }
    return data;
  }

  // ===== REALTIME =====

  function subscribeToTeamContexts(teamId, callbacks = {}) {
    if (realtimeClose) {
      realtimeClose();
      realtimeClose = null;
    }

    let socket = null;
    let heartbeat = null;
    let closed = false;
    let refCounter = 1;

    const close = () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
    };

    (async () => {
      const session = await AUTH.getSession();
      if (closed) return;
      if (!session?.access_token) {
        callbacks.onError?.(apiError('Sign in to receive team updates', 401));
        return;
      }

      const wsUrl = `${SUPABASE_URL.replace('https://', 'wss://')}/realtime/v1/websocket?apikey=${encodeURIComponent(
        SUPABASE_ANON_KEY,
      )}&vsn=1.0.0`;

      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            topic: 'realtime:public:memories',
            event: 'phx_join',
            payload: {
              config: {
                broadcast: { self: false },
                presence: { key: '' },
                postgres_changes: [
                  {
                    event: '*',
                    schema: 'public',
                    table: 'memories',
                    filter: `team_id=eq.${teamId}`,
                  },
                ],
              },
              access_token: session.access_token,
            },
            ref: String(refCounter++),
          }),
        );

        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                topic: 'phoenix',
                event: 'heartbeat',
                payload: {},
                ref: String(refCounter++),
              }),
            );
          }
        }, 30000);
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.event !== 'postgres_changes') return;
          const payload = message.payload || {};
          if (payload.eventType === 'INSERT') callbacks.onInsert?.(payload.new);
          else if (payload.eventType === 'UPDATE') callbacks.onUpdate?.(payload.new);
          else if (payload.eventType === 'DELETE') callbacks.onDelete?.(payload.old);
        } catch {
          /* ignore malformed frames */
        }
      };

      socket.onerror = (error) => callbacks.onError?.(error);
      socket.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      };
    })();

    realtimeClose = close;
    return close;
  }

  function unsubscribeFromRealtime() {
    if (realtimeClose) {
      realtimeClose();
      realtimeClose = null;
    }
  }

  global.API = {
    // auth
    signIn,
    signUp,
    signOut,
    getSession,
    getAccessToken,
    detectV2Session,
    getV2Session,
    // profile
    getExtensionUserId,
    // memories
    listMemories,
    getMemory,
    getMemoryRaw,
    upsertMemory,
    createMemory,
    updateMemory,
    deleteMemory,
    shareMemoryToTeam,
    getTeamMemories,
    getTeamContexts,
    syncLocalContexts,
    // teams
    createTeam,
    joinTeam,
    leaveTeam,
    getUserTeams,
    getTeamMembers,
    getTeamSummaries,
    createTeamSummary,
    // edge functions
    recallMemory,
    mergeTeamContext,
    migrateUserData,
    // realtime
    subscribeToTeamContexts,
    unsubscribeFromRealtime,
  };
})(typeof self !== 'undefined' ? self : window);