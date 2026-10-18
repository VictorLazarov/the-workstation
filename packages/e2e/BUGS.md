# Bugs found by the e2e suite

Each bug has a matching test marked with `test.fail()` so the suite stays green while the defect exists.
When a fix lands, that test starts failing with "Expected to fail, but passed": remove the `test.fail`
line (and the bug comment) so it becomes a normal regression test.

Run against the mock (`WORKSTATION_MOCK=1`), built from the working tree at the time of the run.

---

## BUG-001: a rejected token shows "Connecting to the server…" forever

> **FIXED** (scrutiniser pass 2, M2). The client now probes `/api/health` with the Bearer token; a refusal shows the
> full-screen "Access token missing or invalid" state with how to get the right link and a Retry button, and the
> WebSocket stops retrying (backoff capped at 30s, at most 10 attempts, then an "offline" banner with Retry). The
> `test.fail()` was removed; the regression tests are in `tests/app/token.spec.ts` (and `lib/access.test.ts`,
> `lib/transport/ws.test.ts` in the web package). The text below is the original report.

- **Severity:** medium (usability; no security impact, the token is still enforced)
- **Test:** `tests/app/token.spec.ts`, "a wrong token is detected through /api/health…" (was an expected-fail)

**Repro**
1. Start the server in mock mode: `WORKSTATION_MOCK=1 node packages/server/dist/cli.js --no-open --port 7777`.
2. Open `http://127.0.0.1:7777/?token=wrong-token-value-123` (any token that is not the server's).
3. Wait 30 seconds.

**Expected:** the page says the access token was rejected, for example "Server rejected the access
token. Open the link printed by the server.", and does not pretend to be connecting.

**Actual:** the banner reads "Connecting to the server…" with a "Retry now" button, the sidebar reads
"Connecting…", and the WebSocket is retried forever. The server answers each upgrade with HTTP 401
(`HTTP Authentication failed; no valid credentials available`), and the client only sees a closed
socket, so the access error copy never appears.

**Where:**
- `packages/server/src/app.ts` (~line 230): the upgrade is rejected with a bare `401` and no body or code the client can read.
- `packages/web/src/lib/transport/ws.ts`: `onclose` and `onerror` both collapse into `closed`; there is no auth-failure signal.
- `packages/web/src/components/Overlays.tsx`, `ConnectionBanner`: the text "Check your access token" exists, but it is only shown when the socket is open and `configError` is set, so a wrong token never reaches it.

---

## BUG-002: the model chip shows the raw alias after choosing a model

> **FIXED.** `ModelChip` now names the chosen model by its entry in the server's model list (`Opus`, `Sonnet`, `Default`), falling back to
> `modelLabel()` for ids not in the list. The `test.fail()` was removed; the test is a normal regression test. Original report below.

- **Severity:** low (cosmetic, but visibly inconsistent)
- **Test:** `tests/app/features.spec.ts`, "BUG-002: the model chip shows the friendly name of the chosen model"

**Repro**
1. Open a project and start a session. Send any prompt (for example `hello`).
2. In the composer toolbar click the model chip ("Default model").
3. Choose "Opus" from the menu.

**Expected:** the chip reads "Opus", the same label as the menu item.

**Actual:** the chip reads `opus` (lowercase). The menu item is correct ("Opus", from the model list's
display name), but the chip is derived from the raw id.

**Where:** `packages/web/src/lib/utils.ts`, `modelLabel()`, only prettifies full ids such as
`claude-opus-4-1`. For the SDK aliases (`opus`, `sonnet`, `haiku`) it returns the id unchanged.
`packages/web/src/components/Chips.tsx`, `ModelChip`, calls `modelLabel(cur)` instead of looking up the
selected entry's `label` in the model list.
