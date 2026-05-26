# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-27
**Commit:** HEAD
**Branch:** main

## OVERVIEW
Qwen Gate: OpenAI-compatible API gateway for Qwen models. TypeScript/Node.js + Hono + Playwright. Proxies chat.completions, manages multi-account auth, streams SSE responses.

## STRUCTURE

.
├── src/
│   ├── services/    # Auth, session pool, Playwright orchestration (see src/services/AGENTS.md)
│   ├── routes/      # API endpoints, streaming handlers (see src/routes/AGENTS.md)
│   ├── tools/       # Tool registry, executor, parsing logic
│   ├── utils/       # Helpers, types, constants
│   └── tests/       # Integration + unit tests
├── scripts/         # Setup, discovery, build helpers
├── .env             # Config: PORT, API_KEY, BROWSER, tool limits
└── package.json     # Scripts: start, login, test, build


## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add API endpoint | `src/routes/*.ts` | Use Hono router, SSE streaming for chat |
| Modify auth flow | `src/services/auth.ts` | Handles token refresh, account rotation |
| Browser automation | `src/services/playwright.ts` | AccountContext isolation, header extraction |
| Tool execution | `src/tools/executor.ts` | Loop: parse → validate → execute → stream |
| Add config option | `.env` + `src/index.ts` | dotenv.config(), process.env access |
| Run tests | `src/**/*.test.ts` | `npm test` uses node:test + tsx |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `app` | Hono instance | `src/index.ts:26` | Main router, middleware registration |
| `chatCompletions` | Route handler | `src/routes/chat.ts` | OpenAI-compatible streaming endpoint |
| `initAuth` | Auth initializer | `src/services/auth.ts:589` | Loads accounts, starts hot-reload watcher |
| `createAccountContext` | Context factory | `src/services/playwright.ts:233` | Isolated BrowserContext per account |
| `executeToolCall` | Tool runner | `src/tools/executor.ts` | Parses, validates, executes tool calls |

## CONVENTIONS
- **Streaming**: All chat responses use SSE (`hono/streaming`); callbacks must return immediately after `yield` to flush `[DONE]`.
- **Auth**: Passwords hashed SHA-256 before API call; tokens persisted to `qwen_profile/cookies/<md5>.json`.
- **Browser**: Playwright contexts isolated per account via `BrowserContext`; never share pages across accounts.
- **Tools**: Max 2 tool calls per LLM response (circuit breaker at 10); loop limited to 3 turns.

## ANTI-PATTERNS (THIS PROJECT)
- ❌ Adding logic after callback return in Hono streaming handlers (`src/routes/chat.ts:1414`) — breaks SSE flush.
- ❌ Using `activePage` variable directly — always use `getActivePage()` from `playwright.ts`.
- ❌ Sending `login_type: "email"` to Qwen signin API — field not recognized, causes validation error.
- ❌ Parallel account logins at startup — triggers Qwen WAF; sequential with 1-2s delays required.

## UNIQUE STYLES
- **Account rotation**: Round-robin + in-flight tracking + throttling (120s cooldown on failure).
- **Header extraction**: Playwright `page.route` intercepts `bx-umidtoken`/`bx-ua` from browser fetches.
- **Hot-reload**: `fs.watch` on `qwen_profile/cookies/` with 500ms debounce + 2s startup grace period.

## COMMANDS
bash
npm start                    # Run server (default port 26405)
npm run login user@x.com    # Manual browser login, saves token
npm test                     # Run all tests (node:test + tsx)
npm run build               # TypeScript compile to dist/
npm run qg:ulw              # Start ultrawork mode CLI


## NOTES
- `qwen_profile/` is gitignored; contains runtime tokens + persistent Chromium profiles.
- API_KEY in `.env` protects endpoints; leave empty for dev.
- Browser engine: `BROWSER=chromium` (default), also supports firefox/chrome/edge.
- Tool execution loop: parse → validate → execute → stream; aborts on 3 failed attempts.