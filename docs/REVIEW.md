# Scrutiniser charter (the demanding reviewer)
Nothing is reported to the owner as done until a scrutiniser pass has run on it. The scrutiniser is adversarial,
independent of the author, and trusts nothing: not agent reports, not passing tests, not its own first impression.
Goal: the owner should never find an obvious gap before we do.

## Method
1. **Run it for real.** Build, start the mock server and real-SDK paths, drive the app with Playwright (Chromium at
   /opt/pw-browsers, never `playwright install`). Click every control that exists. Use light + dark, 3 viewport
   widths (1480, 1100, 800), compact + comfortable density, both brands.
2. **Look at it.** Take screenshots and actually read them against docs/UX.md, docs/BRAND.md and the owner's
   reference screenshots. Judge like a picky designer: alignment, spacing rhythm, touching/overlapping elements,
   clipped or wrapped text, inconsistent radii/fonts, orange (Horizon forbids it), dead space, heavy chrome.
3. **Measure it.** Programmatic layout lint on every screen state: element overlap, siblings with 0px gap that
   should have one, horizontal overflow, text truncated without ellipsis/tooltip, hit targets < 24px, computed
   colour contrast < AA, forbidden hues, console errors/warnings, failed network requests, unhandled rejections.
4. **Break it.** Empty states, 500-message conversations, very long titles/paths/lines, rapid input, reconnects,
   killing the server mid-run, wrong token, huge tool output, unicode/RTL, paste of 20MB, double-clicks, Esc/Tab
   keyboard-only operation, screen-reader names on controls.
5. **Read the code** for what the UI can't show: security (auth/Origin/CSRF/CSWSH, path traversal, command and
   argument injection, secret leakage to logs/PTY/custom base URL, XSS via markdown/diff/tool output, SSRF),
   resource leaks, race conditions, error handling, dead code, duplicated logic, missing tests.
6. **Verify claims**: re-run the tests yourself; reproduce every bug before reporting it; say what you could NOT test.

## Output
A prioritized list: BLOCKER / MAJOR / MINOR / NIT, each with repro steps, expected vs actual, a screenshot path
or file:line, and a suggested fix. End with a verdict: SHIP / FIX-THEN-SHIP / NOT READY, plus "what I did not test".
No praise padding. Do not fix code unless asked; findings go to the lead.

## Gate
BLOCKER or MAJOR findings must be fixed and re-checked by the scrutiniser before the owner is told it is done.
Add a regression test (unit or e2e layout-lint) for every bug found.
