# Brand language: SAP Horizon hints (wave 3, token-level)
Owner request: take hints from SAP's visual language — their typeface, colours, and purple for AI-related UI.
We take *hints*, not a copy: no SAP logos/wordmarks, product name stays "The Workstation".

## Verified facts (from `@sap-theming/theming-base-content@11.36.5`, Apache-2.0, `sap_horizon` theme)
- Typeface **"72"** (woff2 shipped in that package: `content/Base/baseLib/baseTheme/fonts/72-*.woff2`),
  stack `"72","72full",Arial,Helvetica,sans-serif`. Bundle the Regular/Semibold/Bold subset we use and include the
  Apache-2.0 license text + attribution in `THIRD_PARTY_NOTICES.md`. Re-confirm the font files' own license before release.
- Horizon light: brand/emphasis blue `#0070f2`, text `#131e29`, page background `#f5f6f7`, neutral `#eff1f2`,
  selected-row `#ebf8ff`, shell/base `#ffffff`, shadow base `#223548`. Dark theme: `sap_horizon_dark` in the same package.
## Our choices (not SAP-specified; I found no AI-purple token in the base theme)
- **AI accent = a violet/purple** used ONLY for agent-related surfaces: agent messages' accent, "working" state,
  thinking blocks, plan/AI badges, sparkle icon, subtle violet→blue gradient on the active agent indicator.
  Candidate `#7858ff` (verify AA contrast on both themes). Blue `#0070f2` stays for primary actions/links; the
  current terracotta accent is retired.
- Shape language: Fiori-style 0.5rem radii, flat surfaces, thin borders, clear focus rings, dense-but-calm spacing.
## Implementation plan
1. All colours/fonts/radii already flow from `packages/web/src/styles/tokens.css`; swap tokens, add `--ai-*` tokens.
2. Keep a theme switch (`data-brand`) so Claude-warm vs Horizon can be compared side by side before committing.
3. Check contrast (AA) for text, chips, status dots in light + dark; re-shoot screenshots for owner review.
