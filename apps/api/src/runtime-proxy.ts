import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import websocket from "@fastify/websocket";
import WebSocket from "ws";

/** Body types whose absolute paths have to be rewritten for the sub-path mount. */
const REWRITABLE = /^(?:text\/html|text\/css|application\/javascript|text\/javascript|application\/x-javascript)/;
/** Bodies that may embed absolute paths but must never be rewritten: JSON is an API payload. */
const STRUCTURED = /^(?:application\/json|[^;]*\+json)/;

/** Methods that only read. Everything else has to prove it came from the console. */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Upstream dial deadline: a runtime that accepts a request and never answers must not hold
 *  a console socket (and an operator's spinner) open forever. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Response headers that stay meaningful on the wire (cookies, redirects, CSP) are re-derived
 *  here, not forwarded: they would otherwise let the runtime's origin leak onto the console. */
const DROPPED_HEADERS = new Set([
  "location", "set-cookie", "content-length", "content-encoding", "transfer-encoding",
  "content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "permissions-policy", "strict-transport-security",
]);

export interface RuntimeRoute {
  /** Host the API dials, e.g. `10.43.12.7` or `snowluma-x.runtime.svc`. */
  host: string;
  /** The port the runtime's own listener uses, which is not always the published host port. */
  port: number;
  /** Transport the runtime listens on; a proxied UI may be TLS even when the console is not. */
  scheme?: "http" | "https";
  /** Path prefix the runtime is served under, for an operator-provided entry point. */
  basePath?: string;
  /** Query string the runtime expects, if its UI cannot run without one. */
  query?: string | null;
}

export interface RuntimeProxyOptions {
  /** Authorises the caller for one endpoint. Throws DatabaseError when it is not theirs. */
  authorize(request: FastifyRequest, endpointId: string, port: number): Promise<{ workspaceId: string }>;
  /** Where the endpoint's runtime is reachable from this API, or null when there is no route. */
  route(workspaceId: string, endpointId: string, port: number): Promise<RuntimeRoute | null>;
  /** Upstream dial deadline in milliseconds; defaults to UPSTREAM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Lifetime of a mount ticket in milliseconds; defaults to TICKET_TTL_MS. */
  ticketTtlMs?: number;
}

/**
 * Serves the runtime's own UI (SnowLuma WebUI, LLBot/NapCat WebUI, noVNC) through the console.
 *
 * Operators configure everything from the console — QQ login, OneBot websocket settings — and
 * those screens live inside the runtime container. Docker published the ports on the agent
 * host, so the console could point a browser at `<host>:<port>`. Kubernetes only gives a
 * ClusterIP, which no browser can dial, so the console proxies instead.
 *
 * The proxy is a content channel, not a console: the runtime's pages run in a sandboxed,
 * opaque-origin frame whose scripts cannot carry the console's session (see frameDocument), so
 * a compromised runtime UI cannot call the console's API as the operator. Sub-resource
 * authentication therefore rides on a mount ticket (see TicketStore) rather than on a cookie.
 */
/** How long a minted mount ticket stays usable. */
export const TICKET_TTL_MS = 45 * 60_000;
/** Ceiling on live tickets: the store is a convenience cache, not a database. */
const TICKET_LIMIT = 512;
/** `/t/<32 hex>` right after the mount prefix, or nothing. */
const TICKET_PATH = /^\/t\/([0-9a-f]{32})(?=[/?#]|$)/;

interface RuntimeTicket {
  endpointId: string;
  port: number;
  workspaceId: string;
  expiresAt: number;
}

/**
 * Short-lived proof that the console opened this mount, carried in the URL path.
 *
 * The proxied document is served with a CSP `sandbox` that leaves it in an opaque origin, and
 * a browser treats such a frame as third-party: its `<script>`, CSS and XHR requests do not
 * carry the console's `SameSite=Lax` session cookie. Without a ticket every one of them would
 * come back 404 from `authorize` and noVNC would show "encountered an error" over a blank
 * canvas. So the first (cookie-bearing) document navigation mints a ticket and redirects the
 * frame into `<mount>/t/<ticket>/…`; the injected `<base>` puts every later request under the
 * same path, which is what authorises them.
 *
 * Tickets live in this process only: they cannot be forged, they are bound to one endpoint and
 * one published port, and a restart merely costs the operator a reload.
 */
class TicketStore {
  private readonly entries = new Map<string, RuntimeTicket>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  mint(endpointId: string, port: number, workspaceId: string) {
    const now = Date.now();
    this.sweep(now);
    if (this.entries.size >= TICKET_LIMIT) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const token = randomBytes(16).toString("hex");
    this.entries.set(token, { endpointId, port, workspaceId, expiresAt: now + this.ttlMs });
    return token;
  }

  /** The workspace the ticket was minted for, or null when it is stale or for another mount. */
  redeem(token: string, endpointId: string, port: number) {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(token);
      return null;
    }
    if (entry.endpointId !== endpointId || entry.port !== port) return null;
    return entry.workspaceId;
  }

  private sweep(now: number) {
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
  }
}

export function registerRuntimeProxy(app: FastifyInstance, options: RuntimeProxyOptions) {
  const mount = (id: string, port: number) => `/api/v1/endpoints/${id}/runtime/${port}`;
  const tickets = new TicketStore(options.ticketTtlMs ?? TICKET_TTL_MS);

  // Encapsulated so the websocket plugin is always loaded before the route that needs it,
  // whichever order the caller registers things in.
  app.register(async scope => {
    await scope.register(websocket);

    // @fastify/websocket only accepts a websocket handler on GET, so the upgrade and the
    // plain HTTP traffic share the prefix through two routes: noVNC's `/websockify` lands on
    // the GET route, the WebUI's REST calls on the other.
    scope.route({
      method: "GET",
      url: "/api/v1/endpoints/:id/runtime/:port/*",
      wsHandler: (socket, request) => { void bridgeWebSocket(socket, request, options, tickets); },
      handler: async (request, reply) => { await bridgeHttp(request, reply, options, tickets); },
    });

    scope.route({
      method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/api/v1/endpoints/:id/runtime/:port/*",
      handler: async (request, reply) => { await bridgeHttp(request, reply, options, tickets); },
    });

    scope.get("/api/v1/endpoints/:id/runtime/:port", async (request, reply) => {
      const { id, port } = mountParams(request);
      return reply.redirect(`${mount(id, port)}/`, 307);
    });
  });
}

function mountParams(request: FastifyRequest) {
  const params = request.params as { id?: string; port?: string };
  return { id: params.id ?? "", port: Number(params.port ?? 0) };
}

/** Path the runtime expects, relative to the mount. */
function upstreamPath(request: FastifyRequest, prefix: string) {
  const raw = request.raw.url ?? "/";
  const cut = raw.indexOf(prefix);
  const rest = cut === -1 ? "/" : raw.slice(cut + prefix.length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * The console's own marker on a mutation.
 *
 * A cross-site page cannot set a custom request header without a preflight, so requiring one
 * refuses form posts and image probes while leaving the proxied UI free to submit normally —
 * the console stamps the header on the frame's own requests (see frameDocument), and the
 * browser's Sec-Fetch-Site covers the UI's own same-origin fetches.
 */
export const SAME_ORIGIN_HEADER = "x-botroost-runtime-proxy";

function fromConsole(request: FastifyRequest) {
  if (SAFE.has(request.method)) return true;
  if (request.headers[SAME_ORIGIN_HEADER] === "1") return true;
  // Same-origin fetch from a proxied frame: the browser stamps the header and Vary itself.
  return request.headers["sec-fetch-site"] === "same-origin" && Boolean(request.headers["sec-fetch-mode"]);
}

/**
 * Whether a websocket handshake comes from the console or from a frame the console sandboxed.
 *
 * The handshake is a GET, so `fromConsole` cannot demand the custom header: a foreign page
 * would simply be refused here instead. `Origin: null` is the opaque origin of the console's
 * own sandboxed frame, which is exactly the caller the proxy exists for.
 */
function fromSameOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin || origin === "null") return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function privateIPv4(host: string) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  // Loopback, the cluster's own CIDRs (10/8, 172.16/12, 192.168/16) and CGNAT. Link-local
  // 169.254/16 is refused: that range carries the cloud metadata endpoint.
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function privateIPv6(host: string) {
  if (host === "::1") return true;
  const first = host.split(":")[0]?.toLowerCase() ?? "";
  return /^f[cd][0-9a-f]{0,2}$/.test(first) || /^fe[89ab][0-9a-f]?$/.test(first);
}

/**
 * The dial address the agent reported, or null when it is not cluster-local.
 *
 * An agent heartbeat is not a licence to point the console at an arbitrary destination: a
 * compromised agent could otherwise report `loginGuide.webuiHost` = some public host and turn
 * the console into an SSRF proxy that returns the response. Only private literals and
 * Kubernetes Service names are accepted, and the port always comes from the same guide.
 */
export function runtimeDialHost(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return null;
  // A bare host, never `host:port` or `host/path`: the proxy appends the port itself.
  if (!/^[a-z0-9._:-]+$/.test(host)) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return privateIPv4(host) ? host : null;
  if (host.includes(":")) return privateIPv6(host) ? host : null;
  // A Service name in the same namespace, or `<name>.<namespace>.svc[.cluster.local]`.
  const service = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*\.svc(?:\.cluster\.local)?$/;
  if (service.test(host) || !host.includes(".")) return host;
  return null;
}

/** Resolves the dial target, or answers with the reason there is none. */
async function resolveTarget(request: FastifyRequest, options: RuntimeProxyOptions, tickets: TicketStore) {
  const { id, port } = mountParams(request);
  if (!id) return { error: { status: 400, body: { error: "bad_request", message: "endpoint is required" } } } as const;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: { status: 400, body: { error: "bad_request", message: "invalid runtime port" } } } as const;
  }
  const base = `/api/v1/endpoints/${id}/runtime/${port}`;
  const ticket = TICKET_PATH.exec(upstreamPath(request, base))?.[1] ?? null;
  // A ticket is the console's own capability for this mount, so it covers what the frame does
  // with it — including the form posts a WebUI login needs from an opaque origin.
  if (!ticket && !fromConsole(request)) {
    return { error: { status: 403, body: { error: "forbidden", message: "runtime proxy requests must come from the console" } } } as const;
  }
  let workspaceId: string;
  if (ticket) {
    // Inside a ticketed mount a request presents no cookie: the ticket is the credential, and
    // it is only good for this endpoint and this published port.
    const owner = tickets.redeem(ticket, id, port);
    if (!owner) {
      return { error: { status: 404, body: { error: "not_found", message: "endpoint not found" } } } as const;
    }
    workspaceId = owner;
  } else {
    try {
      ({ workspaceId } = await options.authorize(request, id, port));
    } catch {
      // An endpoint that is not the caller's must look non-existent, not forbidden: the
      // console shows one message for "gone" and another for "not yours".
      return { error: { status: 404, body: { error: "not_found", message: "endpoint not found" } } } as const;
    }
  }
  // The route lookup is also the SSRF guard: it maps the console's port to a host and port
  // the agent actually published, so the caller can never choose an address.
  let route: RuntimeRoute | null;
  try {
    route = await options.route(workspaceId, id, port);
  } catch {
    // A lookup failure is the console's problem, not the runtime's: say so instead of
    // pretending the runtime is unreachable.
    return { error: { status: 503, body: { error: "unavailable", message: "endpoint state is unavailable" } } } as const;
  }
  if (!route) {
    // The endpoint exists but its node reports no reachable UI: the agent has not observed the
    // runtime yet, or the workload is stopped.
    return { error: { status: 409, body: { error: "runtime_unreachable", message: "the runtime UI for this endpoint is not reachable yet" } } } as const;
  }
  return { target: route, prefix: ticket ? `${base}/t/${ticket}` : base, workspaceId, ticketed: Boolean(ticket) } as const;
}

/** Browser header for the authority: IPv6 literals need brackets in a URL. */
export function authority(host: string, port: number) {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${bracketed}:${port}`;
}

/**
 * Upstream URL for one request: the runtime's own scheme, its path prefix when an operator
 * entry point serves it under one, and the query it needs if the console sent none.
 */
export function targetUrl(target: RuntimeRoute, request: FastifyRequest, prefix: string) {
  const scheme = target.scheme === "https" ? "https:" : "http:";
  const rest = upstreamPath(request, prefix);
  const base = target.basePath ? target.basePath.replace(/\/+$/, "") : "";
  const search = rest.includes("?") || !target.query ? "" : target.query;
  return new URL(`${scheme}//${authority(target.host, target.port)}${base}${rest}${search}`);
}

/**
 * Whether a request is the frame's own document navigation, i.e. the one request a sandboxed
 * runtime UI still makes with the console's session cookie attached.
 */
function wantsDocument(request: FastifyRequest) {
  return String(request.headers.accept ?? "").includes("text/html");
}

async function bridgeHttp(request: FastifyRequest, reply: FastifyReply, options: RuntimeProxyOptions, tickets: TicketStore) {
  const resolved = await resolveTarget(request, options, tickets);
  if ("error" in resolved) return reply.code(resolved.error.status).send(resolved.error.body);
  const { target, prefix } = resolved;
  // The document navigation is the only request the browser sends with the console's session;
  // hand the frame a ticket so the scripts, styles and `websockify` it asks for next are
  // authenticated too — a sandboxed frame's own requests carry no cookie at all.
  if (!resolved.ticketed && request.method === "GET" && wantsDocument(request)) {
    const { id, port } = mountParams(request);
    const token = tickets.mint(id, port, resolved.workspaceId);
    const rest = upstreamPath(request, `/api/v1/endpoints/${id}/runtime/${port}`);
    return reply.redirect(`${prefix}/t/${token}${rest}`, 307);
  }
  const incoming = request.raw;
  const url = targetUrl(target, request, prefix);

  reply.hijack();
  const response = reply.raw;
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    // The console's session cookie is not the runtime's, and its origin is not the runtime's:
    // forwarding either would hand a credential across trust boundaries.
    if (name === "cookie" || name === "host" || name === "origin" || name === "referer") continue;
    // Ask for the body uncompressed so a rewrite never has to decode it.
    if (name === "accept-encoding") continue;
    if (value !== undefined) headers[name] = value;
  }
  headers.host = url.host;
  headers["accept-encoding"] = "identity";
  // The runtime's own cookies come back scoped to this mount, so only those are forwarded.
  const runtimeCookies = cookiesFor(request);
  if (runtimeCookies) headers.cookie = runtimeCookies;

  const client = url.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = client(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: incoming.method,
      headers: headers as Record<string, string | string[]>,
      timeout: options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    },
    result => { void pipeResponse(result, response, prefix, target); },
  );
  upstream.on("timeout", () => {
    upstream.destroy(new Error("runtime timed out"));
  });
  upstream.on("error", (error: Error) => {
    const timedOut = /timed out/.test(error.message);
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(timedOut ? 504 : 502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: timedOut ? "runtime_timeout" : "runtime_unreachable" }));
  });
  // Fastify may already have consumed the body: replay what it parsed instead of piping a
  // drained stream, which would reach the runtime empty.
  const body = request.body;
  if (body === undefined || body === null) { upstream.end(); return; }
  upstream.end(typeof body === "string" ? body : Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** Cookies the runtime set on this mount, with the console's own ones left behind. */
function cookiesFor(request: FastifyRequest) {
  const jar = request.cookies as Record<string, string> | undefined;
  if (!jar) return null;
  // @fastify/cookie parses the whole Cookie header without path scoping, so the runtime's
  // cookies are told apart by name: everything the console issued is `botroost_`-prefixed.
  const runtime = Object.entries(jar).filter(([name]) => !name.startsWith("botroost_"));
  return runtime.length ? runtime.map(([name, value]) => `${name}=${value}`).join("; ") : null;
}

async function pipeResponse(upstream: IncomingMessage, response: ServerResponse, prefix: string, target: RuntimeRoute) {
  const status = upstream.statusCode ?? 502;
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name)) continue;
    headers[name] = value as string | string[];
  }
  const location = upstream.headers.location;
  if (location) headers.location = rewriteLocation(location, prefix, target);
  const cookies = upstream.headers["set-cookie"];
  if (cookies) {
    // Scope the runtime's cookies to its mount so they cannot shadow the console session, and
    // keep them out of script reach: the frame's scripts run with an opaque origin anyway.
    headers["set-cookie"] = cookies.map(cookie => cookie
      .replace(/;\s*(?:path|domain)=[^;]*/gi, "")
      .replace(/;\s*httponly/gi, "")
      .concat(`; Path=${prefix}; HttpOnly; SameSite=Lax`));
  }

  const type = String(upstream.headers["content-type"] ?? "");
  const encoded = Boolean(upstream.headers["content-encoding"]);
  if (encoded || STRUCTURED.test(type) || !REWRITABLE.test(type)) {
    response.writeHead(status, headers);
    upstream.pipe(response);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of upstream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  const isDocument = /^text\/html/.test(type);
  const piped = isDocument ? frameDocument(rewriteAbsolutePaths(body, prefix), prefix) : rewriteAbsolutePaths(body, prefix);
  if (isDocument) headers["content-security-policy"] = FRAME_CSP;
  headers["content-length"] = String(Buffer.byteLength(piped));
  response.writeHead(status, headers);
  response.end(piped);
}

/** Keeps a redirect inside the mount, whether it points at the runtime's root or its origin. */
export function rewriteLocation(location: string, prefix: string, target: RuntimeRoute) {
  if (location.startsWith("//")) return location;
  if (location.startsWith("/")) return `${prefix}${location}`;
  try {
    const parsed = new URL(location);
    if (parsed.hostname === target.host || parsed.host === target.host) {
      return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch { /* relative redirect: leave it to the browser, which is already inside the mount */ }
  return location;
}

/**
 * Keeps a runtime's own absolute paths inside the console mount.
 *
 * The runtime UIs are built to be served from `/`, so their markup and bundles reference
 * `/assets/...`, `/vnc.html`, `/websockify`. Mounted under a prefix those requests would hit
 * the console instead, so `"/…` becomes `"<prefix>/…` (same for `'/…` and `(/…`). Protocol
 * relative `//host` and absolute `http://` URLs are left alone.
 */
export function rewriteAbsolutePaths(body: string, prefix: string) {
  return body.replace(/(["'(])\/(?![/\\])/g, (_match, quote: string) => `${quote}${prefix}/`);
}

/**
 * Isolates the proxied document from the console origin.
 *
 * A runtime UI is third-party code: if it ran on the console's origin, a compromised bundle
 * could call `/api/v1/...` with the operator's session cookie. The response therefore carries
 * a CSP `sandbox` directive, which the document cannot lift and which puts the frame in a
 * unique opaque origin: its own scripts still run, but same-origin requests carry no console
 * credentials, and `document.cookie`/`localStorage` of the console are unreachable.
 *
 * `allow-same-origin` is deliberately absent — it would undo the isolation. `<base>` is
 * injected so the UI's relative URLs stay inside the mount, and any CSP the runtime shipped is
 * dropped: it would otherwise be read as an attempt to widen this policy.
 */
export function frameDocument(html: string, prefix: string) {
  const cleaned = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  const head = `<base href="${prefix}/">`;
  return /<head[^>]*>/i.test(cleaned)
    ? cleaned.replace(/<head([^>]*)>/i, `<head$1>${head}`)
    : `${head}${cleaned}`;
}

/** The policy every proxied document goes out with. */
export const FRAME_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";

async function bridgeWebSocket(socket: WebSocket, request: FastifyRequest, options: RuntimeProxyOptions, tickets: TicketStore) {
  if (!fromSameOrigin(request)) {
    socket.close(1008, "cross-origin runtime socket refused");
    return;
  }
  const resolved = await resolveTarget(request, options, tickets);
  if ("error" in resolved) {
    socket.close(1011, resolved.error.body.error);
    return;
  }
  const { target, prefix } = resolved;
  const scheme = target.scheme === "https" ? "wss" : "ws";
  const url = targetUrl(target, request, prefix);
  url.protocol = scheme === "wss" ? "wss:" : "ws:";
  const protocols = socket.protocol ? [socket.protocol] : [];
  const headers: Record<string, string> = {};
  const runtimeCookies = cookiesFor(request);
  if (runtimeCookies) headers.cookie = runtimeCookies;
  // The handshake is a GET, so a cross-site page can open it: require the same evidence as a
  // mutation, and refuse a foreign Origin outright.
  headers["x-botroost-runtime-proxy"] = "1";
  const upstream = new WebSocket(url, protocols, Object.keys(headers).length ? { headers } : {});
  // Frames the browser sends before the upstream handshake completes must not be dropped:
  // noVNC writes its RFB handshake immediately after the socket opens.
  const queued: { data: Buffer; binary: boolean }[] = [];
  socket.on("message", (data: Buffer, binary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, binary });
  });
  socket.on("close", () => upstream.close());
  upstream.on("open", () => {
    for (const frame of queued.splice(0)) upstream.send(frame.data, { binary: frame.binary });
  });
  upstream.on("message", (data: Buffer, binary: boolean) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
  });
  upstream.on("close", () => socket.close());
  upstream.on("error", () => socket.close(1011, "runtime_unreachable"));
}
