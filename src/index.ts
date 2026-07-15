interface Env {
  BUCKET: R2Bucket;
  UPLOAD_KEY: string;
  GITHUB_TOKEN: string;
  GIST_OWNER: string;
}

interface BadgeRecord {
  owner: string;
  repo: string;
  pr: number;
}

interface ShieldsEndpointResponse {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds?: number;
}

interface ScopeConfig {
  description: string;
  allowedReferers: RegExp[];
  allowedUserAgents: RegExp[];
}

const SCOPES: Record<string, ScopeConfig> = {
  gh: {
    description: "Referer must match *.github.com or *.githubusercontent.com, or User-Agent must match github-camo. Empty referer is allowed.",
    allowedReferers: [
      /^https?:\/\/([a-z0-9-]+\.)*github\.com(\/|$)/i,
      /^https?:\/\/([a-z0-9-]+\.)*githubusercontent\.com(\/|$)/i,
    ],
    allowedUserAgents: [/github-camo/i],
  },
};

const ID_LENGTH = 12;
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  return filename.slice(dot).toLowerCase();
}

const ALLOWED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
]);

function checkAccess(scope: string, request: Request, selfOrigin: string): boolean {
  const config = SCOPES[scope];
  if (!config) return false;

  const referer = request.headers.get("referer") || "";
  const ua = request.headers.get("user-agent") || "";

  // Allow empty referer (direct access, some API clients)
  if (!referer) return true;

  // Same-origin: one of our own pages (e.g. a rendered gist) requesting one of
  // our own images. Correct semantically and survives any referrer-policy change.
  try {
    if (new URL(referer).origin === selfOrigin) return true;
  } catch {
    // Malformed referer — fall through to the allowlist checks.
  }

  if (config.allowedReferers.some((r) => r.test(referer))) return true;
  if (config.allowedUserAgents.some((r) => r.test(ua))) return true;

  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    // Badge management routes — these must run before the generic
    // /api/:scope and /api/:scope/:token routes below, which would otherwise
    // treat "badge" as a scope and serve raw R2 objects.

    // Create badge: POST /api/badge
    if (path === "/api/badge" && request.method === "POST") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await request.json().catch(() => null)) as
        | { owner?: string; repo?: string; pr?: number; description?: string }
        | null;
      if (!body || !body.owner || !body.repo || !body.pr) {
        return new Response("Body must be { owner, repo, pr, description? }", { status: 400 });
      }

      const token = generateId();
      const key = `badge/${token}.json`;
      const record: BadgeRecord = { owner: body.owner, repo: body.repo, pr: Number(body.pr) };
      await env.BUCKET.put(key, JSON.stringify(record), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          createdAt: new Date().toISOString(),
          ...(body.description ? { description: body.description } : {}),
        },
      });

      const jsonUrl = `${url.origin}/badge/${token}.json`;
      const shieldsUrl = `https://img.shields.io/endpoint?url=${encodeURIComponent(jsonUrl)}`;
      return Response.json({ token, jsonUrl, shieldsUrl });
    }

    // List badges: GET /api/badge
    if (path === "/api/badge" && request.method === "GET") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const items: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const listed = await env.BUCKET.list({ prefix: "badge/", cursor, include: ["customMetadata"] });
        for (const obj of listed.objects) {
          const token = (obj.key.split("/").pop() || "").replace(/\.json$/, "");
          const stored = await env.BUCKET.get(obj.key);
          const record = stored ? ((await stored.json()) as BadgeRecord) : null;
          if (!record) continue;
          const meta = obj.customMetadata || {};
          items.push({
            token,
            owner: record.owner,
            repo: record.repo,
            pr: record.pr,
            jsonUrl: `${url.origin}/badge/${token}.json`,
            ...(meta.description ? { description: meta.description } : {}),
            ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
          });
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      return Response.json(items);
    }

    // Delete badge: DELETE /api/badge/:token
    const badgeDeleteMatch = path.match(/^\/api\/badge\/([A-Za-z0-9]+)$/);
    if (badgeDeleteMatch && request.method === "DELETE") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const key = `badge/${badgeDeleteMatch[1]}.json`;
      const existing = await env.BUCKET.head(key);
      if (!existing) {
        return new Response("Not found", { status: 404 });
      }
      await env.BUCKET.delete(key);
      return Response.json({ deleted: key });
    }

    // List scopes: GET /api/scopes
    if (path === "/api/scopes" && request.method === "GET") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = Object.fromEntries(
        Object.entries(SCOPES).map(([name, config]) => [name, { description: config.description }]),
      );
      return Response.json(result);
    }

    // Upload: POST /upload/:scope
    const uploadMatch = path.match(/^\/upload\/([a-z0-9-]+)$/);
    if (uploadMatch && request.method === "POST") {
      const scope = uploadMatch[1];
      if (!SCOPES[scope]) {
        return new Response("Unknown scope", { status: 404 });
      }

      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        return new Response("Missing file field", { status: 400 });
      }

      const ext = getExtension(file.name);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return new Response(`Disallowed file type: ${ext || "(none)"}`, { status: 400 });
      }

      const id = generateId();
      const key = `${scope}/${id}${ext}`;
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");

      const description = formData.get("description");
      await env.BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: {
          uploadedAt: new Date().toISOString(),
          originalName: file.name,
          ...(description ? { description: String(description) } : {}),
        },
      });

      const resultUrl = `${url.origin}/${scope}/${id}/${safeName}`;
      return Response.json({ url: resultUrl, key });
    }

    // List: GET /api/:scope
    const listMatch = path.match(/^\/api\/([a-z0-9-]+)$/);
    if (listMatch && request.method === "GET") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const scope = listMatch[1];
      const items: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const listed = await env.BUCKET.list({ prefix: `${scope}/`, cursor, include: ["customMetadata"] });
        for (const obj of listed.objects) {
          const meta = obj.customMetadata || {};
          const originalName = meta.originalName || obj.key.split("/").pop() || "";
          const token = (obj.key.split("/").pop() || "").replace(/\.[^.]+$/, "");
          items.push({
            key: obj.key,
            token,
            url: `${url.origin}/${scope}/${token}/${originalName}`,
            size: obj.size,
            uploaded: obj.uploaded.toISOString(),
            originalName,
            ...(meta.description ? { description: meta.description } : {}),
            ...(meta.uploadedAt ? { uploadedAt: meta.uploadedAt } : {}),
          });
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      return Response.json(items);
    }

    // Delete: DELETE /api/:scope/:token (finds by prefix)
    const deleteMatch = path.match(/^\/api\/([a-z0-9-]+)\/([A-Za-z0-9]+)$/);
    if (deleteMatch && request.method === "DELETE") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const scope = deleteMatch[1];
      const token = deleteMatch[2];
      const listed = await env.BUCKET.list({ prefix: `${scope}/${token}`, limit: 1 });
      if (!listed.objects.length) {
        return new Response("Not found", { status: 404 });
      }

      const key = listed.objects[0].key;
      await env.BUCKET.delete(key);
      return Response.json({ deleted: key });
    }

    // Public badge endpoint for shields.io: GET /badge/:token.json
    // Must run before the generic /:scope/:id.ext serve route below, which
    // would otherwise match /badge/... and reject it as an unknown scope.
    // Disabled 2026-07-16 along with all other unauthenticated serving — see
    // the gist route above. The Bearer-authenticated /upload and /api routes
    // stay live so stored objects can still be listed and deleted.
    const PUBLIC_SERVING_DISABLED = true;
    const badgeServeMatch = path.match(/^\/badge\/([A-Za-z0-9]+)\.json$/);
    if (badgeServeMatch && (request.method === "GET" || request.method === "HEAD")) {
      if (PUBLIC_SERVING_DISABLED) return new Response("Not found", { status: 404 });
      const token = badgeServeMatch[1];
      const stored = await env.BUCKET.get(`badge/${token}.json`);
      if (!stored) {
        return new Response("Not found", { status: 404 });
      }

      const record = (await stored.json()) as BadgeRecord;
      const status = await fetchPrStatus(record, env.GITHUB_TOKEN);
      const payload: ShieldsEndpointResponse = {
        schemaVersion: 1,
        label: `PR #${record.pr}`,
        message: status.message,
        color: status.color,
        cacheSeconds: 60,
      };
      return new Response(JSON.stringify(payload), {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=60",
        },
      });
    }

    // Render one of my gists as a page: GET/HEAD /gist/:id[/:filename].
    // Must run before the generic /:scope/:token/:filename serve route below,
    // which would otherwise match /gist/<id>/index.html with scope="gist"
    // (no scope config) and reject it. Same ordering reason as the badge routes.
    const gistMatch = path.match(/^\/gist\/([a-zA-Z0-9]+)(?:\/([^/]+))?$/);
    if (gistMatch && (request.method === "GET" || request.method === "HEAD")) {
      // Disabled 2026-07-16: serving secret gists on a public URL was flagged as
      // exposing private information. renderGist is kept below but unreachable.
      return new Response("Not found", { status: 404 });
    }

    // Serve: GET /:scope/:token/:filename (new) or GET /:scope/:id.ext (legacy)
    const serveNewMatch = path.match(/^\/([a-z0-9-]+)\/([A-Za-z0-9]+)\/[^/]+$/);
    const serveLegacyMatch = path.match(/^\/([a-z0-9-]+)\/([A-Za-z0-9]+\.[a-z]+)$/);
    const serveMatch = serveNewMatch || serveLegacyMatch;
    if (serveMatch && (request.method === "GET" || request.method === "HEAD")) {
      if (PUBLIC_SERVING_DISABLED) return new Response("Not found", { status: 404 });
      const scope = serveMatch[1];
      const token = serveMatch[2];

      if (!checkAccess(scope, request, url.origin)) {
        return new Response("Forbidden", { status: 403 });
      }

      // Look up by token prefix — R2 key is always scope/token.ext
      const listed = await env.BUCKET.list({ prefix: `${scope}/${token}`, limit: 1 });
      if (!listed.objects.length) {
        return new Response("Not found", { status: 404 });
      }

      const object = await env.BUCKET.get(listed.objects[0].key);
      if (!object) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

interface GistFile {
  filename: string;
  type: string;
  raw_url: string;
  truncated: boolean;
  content?: string;
}

interface GistResponse {
  owner?: { login: string } | null;
  files?: Record<string, GistFile | null>;
}

// Render a GitHub gist's HTML (or other text) file as a page, restricted to the
// owners in GIST_OWNER. Replaces gistpreview.github.io for our own snapshots:
// images load (see Referrer-Policy below), no 1 MB ceiling (we untruncate via
// raw_url), authenticated fetch, native rendering.
async function renderGist(
  id: string,
  filename: string | undefined,
  request: Request,
  env: Env,
): Promise<Response> {
  const allowlist = (env.GIST_OWNER || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Fail closed: with no configured owners, render nothing.
  if (!allowlist.length) {
    return new Response("Not found", { status: 404 });
  }

  // Secret gists are readable by id even unauthenticated; the token only buys a
  // higher rate limit (5000/hr vs 60/hr). So try it when set, but fall back to
  // an unauthenticated fetch if it's missing or rejected (revoked/expired/wrong
  // scope) rather than failing the whole render on a bad token.
  const apiUrl = `https://api.github.com/gists/${id}`;
  const baseHeaders = {
    "accept": "application/vnd.github+json",
    "user-agent": "gh-image-upload-gist-renderer",
  };
  let apiRes: Response | null = null;
  if (env.GITHUB_TOKEN) {
    apiRes = await fetch(apiUrl, {
      headers: { ...baseHeaders, authorization: `Bearer ${env.GITHUB_TOKEN}` },
    });
    // 401 (bad credentials) / 403 (insufficient scope) → the token itself is the
    // problem, so retry without it. Any other status is the gist's real answer.
    if (apiRes.status === 401 || apiRes.status === 403) {
      apiRes = null;
    }
  }
  if (!apiRes) {
    apiRes = await fetch(apiUrl, { headers: baseHeaders });
  }
  if (!apiRes.ok) {
    return new Response("Not found", { status: 404 });
  }

  const gist = (await apiRes.json()) as GistResponse;

  // Ownership gate. Return 404 (not 403) so the endpoint can't be used as an
  // oracle for whether a given gist id exists.
  const owner = gist.owner?.login?.toLowerCase();
  if (!owner || !allowlist.includes(owner)) {
    return new Response("Not found", { status: 404 });
  }

  // Pick the file: the requested name, else index.html, else the sole file.
  const files = gist.files || {};
  const names = Object.keys(files);
  let chosen: GistFile | null = null;
  if (filename) {
    chosen = files[filename] ?? null;
  } else if (files["index.html"]) {
    chosen = files["index.html"];
  } else if (names.length === 1) {
    chosen = files[names[0]];
  }
  if (!chosen) {
    return new Response("Not found", { status: 404 });
  }

  // Untruncate: the API caps inlined content at 1 MB, so pull raw_url whenever
  // the file is flagged truncated or its content wasn't inlined at all.
  let body: string;
  if (chosen.truncated || chosen.content === undefined) {
    const rawRes = await fetch(chosen.raw_url, {
      headers: { "user-agent": "gh-image-upload-gist-renderer" },
    });
    if (!rawRes.ok) {
      return new Response("Not found", { status: 404 });
    }
    body = await rawRes.text();
  } else {
    body = chosen.content;
  }

  const ext = getExtension(chosen.filename);
  const contentType =
    ext === ".html" || ext === ".htm"
      ? "text/html; charset=utf-8"
      : chosen.type || "text/plain; charset=utf-8";

  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": contentType,
      // Required: the page's images live on this same worker under the gh scope,
      // whose checkAccess only passes an empty (or *.github.com) referer. Without
      // this, the <img> requests carry our origin as referer and 403 — exactly
      // why images break under gistpreview today.
      "referrer-policy": "no-referrer",
      // Gists are mutable and viewed rarely, so revalidate over caching.
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

interface PrStatus {
  message: string;
  color: string;
}

async function fetchPrStatus(record: BadgeRecord, token: string): Promise<PrStatus> {
  if (!token) return { message: "no token", color: "lightgrey" };

  const query = `
    query($owner:String!,$name:String!,$num:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$num){
          state
          merged
          isDraft
          commits(last:1){nodes{commit{statusCheckRollup{state}}}}
        }
      }
    }
  `;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "gh-image-upload-badge-proxy",
    },
    body: JSON.stringify({
      query,
      variables: { owner: record.owner, name: record.repo, num: record.pr },
    }),
  });

  if (!res.ok) return { message: "api error", color: "lightgrey" };
  const data = (await res.json()) as {
    data?: {
      repository?: {
        pullRequest?: {
          state: "OPEN" | "CLOSED" | "MERGED";
          merged: boolean;
          isDraft: boolean;
          commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
        } | null;
      } | null;
    };
  };
  const pr = data.data?.repository?.pullRequest;
  if (!pr) return { message: "not found", color: "lightgrey" };

  if (pr.merged) return { message: "merged", color: "8957e5" };
  if (pr.state === "CLOSED") return { message: "closed", color: "red" };
  if (pr.isDraft) return { message: "draft", color: "lightgrey" };

  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  switch (rollup) {
    case "SUCCESS":
      return { message: "passing", color: "brightgreen" };
    case "FAILURE":
    case "ERROR":
      return { message: "failing", color: "red" };
    case "PENDING":
    case "EXPECTED":
      return { message: "pending", color: "yellow" };
    default:
      return { message: "no checks", color: "lightgrey" };
  }
}
