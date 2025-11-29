# Domain Checker

React 18 + Vite app to queue domains, store them in IndexedDB, and check availability via DNS with optional RDAP follow-up.

## What it does (for users)
- Paste or upload a .txt list of domains (commas/newlines). Inputs are normalized: lowercase, protocols/paths trimmed, `.com` appended if no TLD, duplicates skipped.
- Start/stop the checker. It processes queued domains in batches of up to 50.
- DNS check: NS lookup via dns.google. If NXDOMAIN → mark available and call RDAP (rdap.org) for final availability; any other response → taken or unknown.
- RDAP-only mode: skip DNS and re-run RDAP for domains marked available without a final RDAP result.
- Table with search, filters (status/RDAP), sortable columns (domain/core/created), pagination (20/page), and status bar with queue/running stats.
- Clear history wipes IndexedDB.

## Quick start (developers)
1) Install: `npm install`
2) Run dev server: `npm run dev` (then open the printed local URL)
3) Build: `npm run build`
4) Preview build: `npm run preview`

Requirements: Node.js 18+ recommended.

## Project structure (feature-first)
```
src/
  main.tsx          # App entry
  App.tsx           # Root wiring to the domain feature
  styles/globals.css
  features/
    domains/
      components/   # DomainCheckerPage UI
      hooks/        # useDomainChecker (queue + checker logic)
      services/     # DNS/RDAP lookups + IndexedDB storage
      types/        # Domain types
      utils/        # Normalization, formatting, sorting helpers
```
