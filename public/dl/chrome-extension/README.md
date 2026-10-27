# AI Context Bridge

A Manifest V3 Chrome extension that captures AI conversations, structures them into reusable project memory, and injects that context into any supported AI chat.

## What it does

- **Auto-capture** conversations on supported platforms (toggle in the popup).
- **Manual capture** of a selection or the full visible conversation.
- **Structured memory**: title, topic, summary, key points, decisions, open questions.
- **Inject or copy** context into the current chat, with a clipboard fallback.
- **Cloud sync (optional)**: sign in with email and password to store memories in Supabase.
- **Teams (optional)**: share memories with a team, merge shared knowledge into summaries.
- **Offline queue**: failed cloud writes are retried by a background alarm.

## Supported platforms

| Platform | URL |
| --- | --- |
| ChatGPT | `chatgpt.com`, `chat.openai.com` |
| Claude | `claude.ai` |
| Gemini | `gemini.google.com` |
| Copilot | `copilot.microsoft.com` |
| Poe | `poe.com` |
| Perplexity | `perplexity.ai`, `www.perplexity.ai` |

Selectors change when these products ship new UIs. If capture stops working, update `PLATFORM_CONFIG` in `content.js`.

## Install (unpacked)

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `chrome-extension` folder.
4. Pin the extension if you want quick access.

## First run

1. Enter a display name. This creates a local profile only.
2. Captures now work locally.
3. To sync and use teams, sign in with email and password in the popup. If the Supabase project requires email confirmation, confirm the email first.

## Keyboard shortcuts

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Capture conversation | `Ctrl+Shift+Y` | `Cmd+Shift+Y` |
| Recall memories | `Ctrl+Shift+U` | `Cmd+Shift+U` |
| Inject active project | `Ctrl+Shift+K` | `Cmd+Shift+K` |

These defaults avoid Chrome's reserved DevTools shortcuts. Change them at `chrome://extensions/shortcuts`.

## Data model

- **Local storage** (`chrome.storage.local`) keeps the last 50 structured captures, local projects, settings, and the auth session. Raw text for manual captures is kept locally; auto-captures store raw text in the cloud copy when signed in.
- **Cloud storage** uses the `memories`, `teams`, `team_members`, and `team_summaries` tables in Supabase. Row Level Security restricts every row to its owner or a team member.
- **Projects** in the extension are local. The web dashboard has its own Supabase-backed projects.

## Configuration

Edit `config.js` to point the extension at another Supabase project:

```js
var APP_CONFIG = Object.freeze({
  supabaseUrl: 'https://<project>.supabase.co',
  supabaseAnonKey: '<publishable/anon key>',
  ...
});
```

Update `host_permissions` in `manifest.json` to match the new Supabase host, and add the host to `connect-src` if you add a CSP.

### Edge function environment

The AI edge functions use any OpenAI-compatible chat-completions endpoint:

| Variable | Required | Default |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | yes | — |
| `AI_GATEWAY_URL` | no | `https://api.openai.com/v1/chat/completions` |
| `AI_MODEL` | no | `gpt-4o-mini` |

`OPENAI_API_KEY` is accepted as a fallback for `AI_GATEWAY_API_KEY`.

## Permissions

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | local captures, settings, auth session, offline queue |
| `activeTab`, `tabs` | detect the current AI platform and inject context |
| `clipboardWrite` | fallback when a composer cannot be scripted |
| `contextMenus` | right-click selection capture |
| `alarms` | retry the offline queue and refresh sessions |
| `offscreen` | clipboard writes from the MV3 service worker |
| `notifications` | capture, sync, and error feedback |

There is no cookie access and no host permission on a separate dashboard origin.

## Files

```
chrome-extension/
├── manifest.json     # MV3 manifest
├── config.js         # Supabase URL/key shared by the popup and worker
├── auth.js           # Supabase email/password auth + token refresh
├── api.js            # Authenticated memory/team REST client
├── background.js     # capture pipeline, queue, alarms, clipboard, routing
├── content.js        # transcript extraction and composer injection
├── offscreen.html/js # clipboard execution context for MV3
├── popup.html/css/js # popup UI and local state
├── icons/
└── README.md
```

## Troubleshooting

- **Capture does nothing**: reload the AI tab so the content script is injected, then try again. The popup shows the reason (no conversation, too short, unsupported page).
- **Injection falls back to copying**: the composer markup changed; the context is copied instead.
- **Cloud sync is silent**: make sure you are signed in and the **Cloud sync** toggle is on. Check the sync icon in the header for the queue state.
- **Team actions fail**: sign in, then open the Team tab again. Joining requires a valid invite code.
- **No raw text on export**: auto-captures keep raw text in the cloud. Sign in or use a manual capture.

## Privacy

Local-only mode sends nothing to a server. When you sign in and enable cloud sync, captured text and structured memory are stored in your Supabase project, protected by Row Level Security. The extension does not include analytics or tracking.

## License

MIT