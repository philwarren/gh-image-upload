# Spec: serve my gists as rendered pages (replace gistpreview for this use case)

## Goal

Add a route to this worker that renders a GitHub gist's HTML file as a web page,
so `figma-to-gist` / `figma-to-pdf` / `auto-gather` snapshots can be opened
without `gistpreview.github.io`. Restricted to **my own gists only** — the worker
refuses to render anyone else's.

Why bother replacing gistpreview:

- **The images actually load.** They don't under gistpreview (confirmed). It
  `document.write`s the HTML, so the screenshot `<img>` requests go out
  cross-origin carrying `Referer: https://gistpreview.github.io/`, which the
  `gh` scope rejects — every screenshot 403s. The snapshot pages have never
  shown their images through gistpreview. See the referer section below; the
  worker serves the page same-origin to its images, so we can make them pass.
- **No 1 MB ceiling.** gistpreview reads the GitHub API's `files[name].content`,
  which the API truncates at 1 MB and never backfills from `raw_url`. The whole
  reason the snapshot skills host images out of band is to dodge that. Serving
  through this worker, we fetch `raw_url` ourselves when a file is truncated, so
  the ceiling disappears.
- **Authenticated fetch.** gistpreview hits `api.github.com` unauthenticated
  (60 req/hr/IP). We already hold a `GITHUB_TOKEN` for the badge proxy; reusing
  it gives 5000 req/hr.
- **Native rendering.** We serve the file as the response body with the right
  content type. The browser renders it directly — no `document.write`, no flash,
  correct base URL. Strictly better than gistpreview's shim.
- **Ours.** No dependency on a third-party github.io page staying up.

## Endpoint

```
GET /gist/:id            → render :id's index.html
GET /gist/:id/:filename  → render a specific file from :id
HEAD on both             → same, no body
```

The delivered URL becomes `https://gh-image-upload.phillip-3f3.workers.dev/gist/<id>`
in place of `https://gistpreview.github.io/?<id>`.

### Behaviour

1. Fetch `https://api.github.com/gists/:id` with the existing `GITHUB_TOKEN`
   (`Authorization: Bearer …`, `User-Agent`, `Accept: application/vnd.github+json`).
   - 404 from GitHub → 404.
2. **Ownership gate.** If `owner.login` is not in the configured allowlist, return
   404 (not 403 — don't confirm the gist exists). This is the "my gists only"
   boundary. Reading the gist is cheap and the check is on the API response, so a
   stranger's gist id never gets served even though it's technically fetchable.
3. Pick the file: the requested `:filename`, else `index.html`, else — if the
   gist has exactly one file — that file. No match → 404.
4. **Untruncate.** If the chosen file's `truncated` is true (or `content` is
   absent), fetch `file.raw_url` and use that body. Otherwise use `content`.
5. Serve the body with `content-type` derived from the file's extension
   (`.html` → `text/html; charset=utf-8`; fall back to the gist file's
   `type`).
6. Response headers:
   - `Referrer-Policy: no-referrer` — **required**, see below.
   - `Cache-Control: no-cache` (revalidate; gists are mutable and viewed rarely,
     so favour freshness over CDN savings).
   - `X-Content-Type-Options: nosniff`.

## The embedded-image referer problem (must-handle)

The snapshot HTML references its screenshots as absolute URLs on this same
worker, under the `gh` scope. The `gh` scope's `checkAccess` allows a request
only when the referer matches `*.github.com` / `*.githubusercontent.com`, or the
referer is **empty**, or the UA is `github-camo`.

Verified against the live worker:

| Referer on the image request        | Result |
|-------------------------------------|--------|
| (none)                              | 200    |
| `https://github.com/…`              | 200    |
| `https://gistpreview.github.io/?…`  | 403    |
| `https://gh-image-upload…workers.dev/…` | 403 |
| `https://evil.example.com/`         | 403    |

This is why the images are broken under gistpreview today: its page is at
`gistpreview.github.io`, so the `<img>` requests carry that origin as referer →
403. A naive worker route inherits the same failure — if it serves the gist page
from this origin and does nothing else, the `<img>` requests carry
`Referer: https://gh-image-upload…workers.dev/gist/…` → also 403. The empty-referer
row is the only same-document case that passes, and only gistpreview's referrer
*stripping* would hit it, which it doesn't do.

Two ways to fix it; do **both**, they're cheap and orthogonal:

1. **`Referrer-Policy: no-referrer` on the gist response** (primary). A document's
   `Referrer-Policy` applies to the subresource requests it initiates, so every
   `<img>` then carries no referer and hits the empty-referer allow path —
   exactly the mechanism gistpreview relies on. Also a privacy win.
2. **Allow same-origin referers in `checkAccess`** (defence in depth). A request
   whose referer origin equals the worker's own origin is by definition one of
   our own pages serving our own image — the correct semantic, and it survives any
   future referrer-policy change. Pass the request URL's origin into `checkAccess`
   and accept when `new URL(referer).origin === self origin`.

## Config

- Reuse the existing `GITHUB_TOKEN` secret, but it **must carry the `gist` read
  scope** (classic PAT: `gist`; fine-grained: Gists → read). Without it the token
  authenticates but GitHub returns **404** for your own *secret* gists, which the
  renderer surfaces as its own 404. This is a hard requirement, not an
  optimisation: unauthenticated by-id reads do work for secret gists in principle
  (that's how gistpreview reads them), but they're capped at 60 req/hr and were
  observed returning 504 intermittently, so the renderer can't rely on them.
  Verify with `curl -H "Authorization: Bearer $TOKEN" https://api.github.com/gists/<id>`
  — a 200 means the scope is right, a 404 means it's missing.
- Add `GIST_OWNER` (var, not secret) — comma-separated login allowlist, e.g.
  `philwarren`. Empty/unset → render nothing (fail closed).

## Routing order

Register the `/gist/:id[/...]` match **before** the generic serve routes. A path
like `/gist/<id>/index.html` otherwise matches the existing
`^/([a-z0-9-]+)/([A-Za-z0-9]+)/[^/]+$` serve pattern with `scope="gist"`, which
has no scope config and would 403/404 as an image lookup. Same ordering reason as
the badge routes.

## Security notes

- The served HTML is my own content and runs in the worker's origin. It can't
  reach the authenticated management endpoints (`/upload`, `/api/*`) — those
  require the `Bearer UPLOAD_KEY`, which the gist HTML doesn't carry — so there's
  no privilege escalation across same-origin. No CSP needed for the use case;
  add one later if untrusted gists ever become renderable.
- Keep the ownership gate returning 404 rather than 403 so the endpoint doesn't
  become an oracle for "does gist X exist".

## Downstream (not this repo)

Once shipped, point the snapshot skills at the new URL:

- `figma-to-gist`, `figma-to-pdf` (gist variant), `auto-gather` — emit
  `…/gist/<id>` instead of `gistpreview.github.io/?<id>` in their publish/verify
  steps.
- The 1 MB-ceiling rationale in those skills can be softened to "page-weight
  hygiene" rather than "hard breakage", since `raw_url` untruncation removes the
  cliff. Hosting images out of band is still the right default for page weight.
