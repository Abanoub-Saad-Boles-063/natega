## Goal
Serve the uploaded Arabic Thanaweya results HTML file exactly as provided, at the site root.

## Steps
1. Copy `user-uploads://New_Text_Document_2.txt` to `public/index.html` (unchanged HTML/CSS/JS, RTL preserved).
2. Remove the placeholder `src/routes/index.tsx` React route so it doesn't shadow the static file, and delete the `src/routes/index.tsx` head/component. Replace `/` with a server route (`src/routes/index.ts`) whose GET handler reads and returns `public/index.html` with `Content-Type: text/html; charset=utf-8` — this guarantees the raw HTML is served at `/` in both dev and production, bypassing the SPA shell.
3. Leave the rest of the app (root layout, styles) untouched; the static page renders independently of React.

## Notes
- The file is 996 lines of self-contained HTML with inline CSS/JS and Google Fonts — no build step needed.
- No backend/data wiring is added; it's purely static hosting of the provided markup.
