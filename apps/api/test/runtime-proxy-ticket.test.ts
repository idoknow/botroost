import Fastify from "fastify";
import WebSocket, { WebSocketServer } from "ws";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerRuntimeProxy } from "../src/runtime-proxy.js";

/**
 * A sandboxed runtime frame sends no cookie on any request it makes itself: only the document
 * navigation carries the console's session. These tests pin the ticket that replaces it —
 * without one, noVNC's `app/ui.js` came back 404 and the panel rendered "encountered an error".
 */

const endpointId = "0b3badb9-1111-2222-3333-444455556666";
const otherEndpointId = "7f1c2d3e-4444-5555-6666-777788889999";

async function fakeRuntime() {
  const seen: { url: string; method: string | undefined }[] = [];
  const server: Server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", method: request.method });
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><script src="/app/ui.js"></script></head><body>ok</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0, seen };
}

const apps: { close(): Promise<void> }[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

/** A console whose session can be switched off, so post-redirect requests prove they need none. */
async function build(runtimePort: number, options: { ticketTtlMs?: number } = {}) {
  const session = { alive: true };
  const app = Fastify();
  registerRuntimeProxy(app, {
    authorize: async () => {
      if (!session.alive) throw new Error("not signed in");
      return { workspaceId: "w1" };
    },
    route: async () => ({ host: "127.0.0.1", port: runtimePort }),
    ticketTtlMs: options.ticketTtlMs ?? 60_000,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  apps.push(app);
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, session };
}

/** The ticketed mount a document navigation is redirected into. */
async function ticketFor(base: string, publishedPort: number, path = "/vnc.html") {
  const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${publishedPort}${path}`, {
    redirect: "manual",
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  expect(response.status).toBe(307);
  return response.headers.get("location") ?? "";
}

describe("runtime mount ticket", () => {
  it("redirects the document navigation into a ticketed mount", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const { base } = await build(runtime.port);

    const location = await ticketFor(base, runtime.port);

    expect(location).toMatch(new RegExp(`^/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/t/[0-9a-f]{32}/vnc\\.html$`));
    // A redirect is not a request to the runtime: the frame has not asked for anything yet.
    expect(runtime.seen).toHaveLength(0);
  });

  it("serves the frame's own sub-resources on the ticket alone", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const { base, session } = await build(runtime.port);
    const mount = (await ticketFor(base, runtime.port)).replace(/\/vnc\.html$/, "");

    // From here on the frame is sandboxed: no session cookie reaches the API.
    session.alive = false;

    const script = await fetch(`${base}${mount}/app/ui.js`);
    expect(script.status).toBe(200);
    expect(runtime.seen.at(-1)?.url).toBe("/app/ui.js");

    const document = await fetch(`${base}${mount}/vnc.html`);
    const body = await document.text();
    expect(document.status).toBe(200);
    expect(body).toContain(`<base href="${mount}/">`);
  });

  it("binds the ticket to one endpoint and one published port", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const { base, session } = await build(runtime.port);
    const ticket = /\/t\/([0-9a-f]{32})/.exec(await ticketFor(base, runtime.port))?.[1] ?? "";
    session.alive = false;

    const otherEndpoint = await fetch(`${base}/api/v1/endpoints/${otherEndpointId}/runtime/${runtime.port}/t/${ticket}/app/ui.js`);
    const otherPort = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port + 1}/t/${ticket}/app/ui.js`);
    const guessed = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/t/${"0".repeat(32)}/app/ui.js`);

    expect(otherEndpoint.status).toBe(404);
    expect(otherPort.status).toBe(404);
    expect(guessed.status).toBe(404);
    expect(runtime.seen).toHaveLength(0);
  });

  it("refuses an expired ticket", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const { base, session } = await build(runtime.port, { ticketTtlMs: 5 });
    const mount = (await ticketFor(base, runtime.port)).replace(/\/vnc\.html$/, "");
    session.alive = false;
    await new Promise(resolve => setTimeout(resolve, 30));

    const response = await fetch(`${base}${mount}/app/ui.js`);

    expect(response.status).toBe(404);
    expect(runtime.seen).toHaveLength(0);
  });

  it("lets the frame post to its own runtime without the console's marker header", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const { base, session } = await build(runtime.port);
    const mount = (await ticketFor(base, runtime.port)).replace(/\/vnc\.html$/, "");
    session.alive = false;

    const response = await fetch(`${base}${mount}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(runtime.seen.at(-1)?.method).toBe("POST");
    expect(runtime.seen.at(-1)?.url).toBe("/api/login");
  });

  it("hands the sandboxed frame CORS headers, without which its ES modules never execute", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const { base, session } = await build(runtime.port);
    const mount = (await ticketFor(base, runtime.port)).replace(/\/vnc\.html$/, "");

    const ticketed = await fetch(`${base}${mount}/app/ui.js`);
    expect(ticketed.headers.get("access-control-allow-origin")).toBe("*");
    expect(ticketed.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

    // Outside the ticket the console session is the credential: a wildcard there would let any
    // page read a response fetched with an operator's cookie.
    const plain = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/app/ui.js`, {
      headers: { "x-botroost-runtime-proxy": "1" },
    });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    expect(session.alive).toBe(true);
  });

  it("answers the frame's CORS preflight itself, which the runtime could not", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const { base, session } = await build(runtime.port);
    const mount = (await ticketFor(base, runtime.port)).replace(/\/vnc\.html$/, "");
    session.alive = false;

    const response = await fetch(`${base}${mount}/api/login`, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(runtime.seen).toHaveLength(0);
  });

  it("forwards a runtime bundle byte for byte", async () => {
    const bundle = 'export const p = d => d.match(/[?&]logging=([A-Za-z0-9._-]*)/);\nconst r = a / b;\n';
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(bundle);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    const runtimePort = typeof address === "object" && address ? address.port : 0;
    const { base, session } = await build(runtimePort);
    const mount = (await ticketFor(base, runtimePort)).replace(/\/vnc\.html$/, "");
    session.alive = false;

    const response = await fetch(`${base}${mount}/app/webutil.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(bundle);
  });

  it("accepts noVNC's websockify inside the ticketed mount without a cookie", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const wss = new WebSocketServer({ server: runtime.server, path: "/websockify" });
    wss.on("connection", client => client.on("message", data => client.send(`echo:${data.toString()}`)));
    const { base, session } = await build(runtime.port);
    const mount = (await ticketFor(base, runtime.port)).replace(/\/vnc\.html$/, "");
    session.alive = false;

    const client = new WebSocket(`${base.replace("http", "ws")}${mount}/websockify`, { headers: { origin: "null" } });
    const echoed = await new Promise<string>((resolve, reject) => {
      client.on("open", () => client.send("RFB 003.008\n"));
      client.on("message", data => resolve(data.toString()));
      client.on("error", reject);
      setTimeout(() => reject(new Error("no echo through the ticketed mount")), 5000);
    });
    client.close();
    wss.close();

    expect(echoed).toBe("echo:RFB 003.008\n");
  });
});
