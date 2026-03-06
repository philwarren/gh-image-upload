interface Env {
  BUCKET: R2Bucket;
  UPLOAD_KEY: string;
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

function checkAccess(scope: string, request: Request): boolean {
  const config = SCOPES[scope];
  if (!config) return false;

  const referer = request.headers.get("referer") || "";
  const ua = request.headers.get("user-agent") || "";

  // Allow empty referer (direct access, some API clients)
  if (!referer) return true;

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

    // Serve: GET /:scope/:token/:filename (new) or GET /:scope/:id.ext (legacy)
    const serveNewMatch = path.match(/^\/([a-z0-9-]+)\/([A-Za-z0-9]+)\/[^/]+$/);
    const serveLegacyMatch = path.match(/^\/([a-z0-9-]+)\/([A-Za-z0-9]+\.[a-z]+)$/);
    const serveMatch = serveNewMatch || serveLegacyMatch;
    if (serveMatch && (request.method === "GET" || request.method === "HEAD")) {
      const scope = serveMatch[1];
      const token = serveMatch[2];

      if (!checkAccess(scope, request)) {
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
