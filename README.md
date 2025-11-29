# Domain Checker

React 18 + Vite app to queue domains, store them in IndexedDB, and check availability via DNS with optional RDAP follow-up.

## Live demo
- https://marcosrioj.github.io/domain-checker/

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

## Deploy to GitHub Pages
- Push to `main` and GitHub Actions will build and publish `dist` to Pages (workflow: `.github/workflows/deploy.yml`).
- The workflow sets `BASE_PATH` to `/<repo-name>/` so assets load under the Pages path; you can override by setting a different `BASE_PATH` env or editing `vite.config.ts`.
- First time setup: in your repo’s Settings → Pages, select “GitHub Actions” as the source. After the first successful run, Pages will be live at `https://<username>.github.io/<repo-name>/`.
- If the deploy step fails with a 404, it means Pages is not enabled yet. Enable it via Settings → Pages (source: GitHub Actions), then rerun the workflow.
