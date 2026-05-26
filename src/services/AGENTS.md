# src/services — Core Runtime

**Domain**: Authentication, session management, browser orchestration

## OVERVIEW
Handles multi-account auth (token refresh, rotation), Playwright BrowserContext isolation, and header extraction for Qwen API calls.

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Add account selection logic | `auth.ts` | `pickAccount()` uses inFlight + totalRequests for load balancing |
| Modify token persistence | `auth.ts:734` | `saveCookies()` writes to `qwen_profile/cookies/<md5>.json` |
| Change browser context setup | `playwright.ts:233` | `createAccountContext()` creates isolated BrowserContext per account |
| Update header extraction | `playwright.ts:280` | `page.route` handler captures `bx-umidtoken`/`bx-ua` |
| Adjust hot-reload debounce | `auth.ts:844` | 500ms debounce + 2s startup grace period |

## CONVENTIONS
- **Account state**: `AccountEntry` tracks `inFlight`, `totalRequests`, `throttledUntil` for rotation.
- **Token format**: JWT decoded for `exp` claim; fallback to `AUTH_TOKEN_MAX_AGE_MS` (default 1h).
- **Browser isolation**: Each account gets unique `BrowserContext`; cookies/storage never shared.
- **Mutex usage**: `loginMutex` serializes browser logins (shared activePage + global cookie jar).

## ANTI-PATTERNS
- ❌ Calling `getActivePage()` without null check — returns `null` if no context exists yet.
- ❌ Using `response.headers.get('set-cookie')` for multiple cookies — use `getSetCookie()` in Node 20+.
- ❌ Parallel `loginFresh()` calls at startup — triggers Qwen WAF; sequential with delays required.
- ❌ Modifying `accountContexts` Map directly — always use exported functions (`createAccountContext`, etc.).

## UNIQUE PATTERNS
- **Lazy context creation**: Account contexts created on-demand, not at startup.
- **Dual login paths**: Browser `page.evaluate()` (WAF-safe) → fetch fallback (Node environment).
- **Cookie refresh**: 30s interval via `setInterval`; skips if token still valid.
- **Graceful degradation**: If browser login fails, falls back to plain fetch with proper headers.