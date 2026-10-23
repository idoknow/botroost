import Fastify from "fastify";
import WebSocket, { WebSocketServer } from "ws";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerRuntimeProxy, rewriteCssAbsolutePaths, rewriteHtmlAbsolutePaths, SAME_ORIGIN_HEADER } from "../src/runtime-proxy.js";

/** A stand-in for the runtime UI inside the pod: records what the proxy sends it. */
async function fakeRuntime(handler?: (url: string, res: import("node:http").ServerResponse) => void) {
  const seen: { url: string; headers: Record<string, string | string[] | undefined>; method: string | undefined }[] = [];
  const server: Server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers, method: request.method });
    if (handler) return handler(request.url ?? "", response);
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><html><head><script src=\"/assets/app.js\"></script></head><body>ok</body></html>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, seen };
}

const apps: { close(): Promise<void> }[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

async function build(runtimePort: number, overrides: Partial<{ authorize: () => Promise<{ workspaceId: string }>; route: () => Promise<{ host: string; port: number } | null> }> = {}) {
  const app = Fastify();
  registerRuntimeProxy(app, {
    authorize: overrides.authorize ?? (async () => ({ workspaceId: "w1" })),
    route: overrides.route ?? (async () => ({ host: "127.0.0.1", port: runtimePort })),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  apps.push(app);
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

const endpointId = "0b3badb9-1111-2222-3333-444455556666";

describe("runtime proxy", () => {
  it("forwards the path and query after stripping the mount", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const base = await build(runtime.port);

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/assets/app.js?v=2`);

    expect(response.status).toBe(200);
    expect(runtime.seen[0]?.url).toBe("/assets/app.js?v=2");
  });

  it("rewrites the runtime's own absolute paths into the mount", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const base = await build(runtime.port);

    const body = await (await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/`)).text();

    expect(body).toContain(`"/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/assets/app.js"`);
    expect(body).not.toContain('"/assets/app.js"');
  });

  it("keeps the console session cookie away from the runtime", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const base = await build(runtime.port);

    await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/`, { headers: { cookie: "botroost_session=secret" } });

    expect(runtime.seen[0]?.headers.cookie).toBeUndefined();
  });

  it("scopes cookies the runtime sets to its mount", async () => {
    const runtime = await fakeRuntime((_url, response) => {
      response.writeHead(200, { "content-type": "text/plain", "set-cookie": "webui=abc; Path=/; HttpOnly" });
      response.end("ok");
    });
    servers.push(runtime.server);
    const base = await build(runtime.port);

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/`);
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(cookie).toContain(`Path=/api/v1/endpoints/${endpointId}/runtime/${runtime.port}`);
    expect(cookie).not.toMatch(/Path=\/;/);
  });

  it("redirects the bare mount to its trailing slash", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const base = await build(runtime.port);

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}`, { redirect: "manual" });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/`);
  });

  it("refuses an endpoint the caller does not own", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const base = await build(runtime.port, { authorize: async () => { throw new Error("not yours"); } });

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/`);

    expect(response.status).toBe(404);
    expect(runtime.seen).toHaveLength(0);
  });

  it("reports an unreachable runtime instead of dialling anything", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const base = await build(runtime.port, { route: async () => null });

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/`);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("runtime_unreachable");
    expect(runtime.seen).toHaveLength(0);
  });

  it("requires the console's own marker on mutating methods", async () => {
    const runtime = await fakeRuntime();
    servers.push(runtime.server);
    const base = await build(runtime.port);
    const url = `${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/api/login`;

    const rejected = await fetch(url, { method: "POST", body: "{}" });
    expect(rejected.status).toBe(403);

    const accepted = await fetch(url, { method: "POST", body: "{}", headers: { [SAME_ORIGIN_HEADER]: "1" } });
    expect(accepted.status).toBe(200);
    expect(runtime.seen.at(-1)?.method).toBe("POST");
  });
});

describe("rewriteHtmlAbsolutePaths", () => {
  it("leaves protocol-relative and absolute URLs alone", () => {
    const body = 'src="//cdn.example.com/a.js" href="http://x/y" src="/app.js"';
    expect(rewriteHtmlAbsolutePaths(body, "/p")).toBe('src="//cdn.example.com/a.js" href="http://x/y" src="/p/app.js"');
  });

  it("rewrites absolute attribute values in either quote style", () => {
    const body = "<link href='/a/b.css'><form action=\"/api/x\"><img data-x=\"/no\">";
    expect(rewriteHtmlAbsolutePaths(body, "/p")).toBe("<link href='/p/a/b.css'><form action=\"/p/api/x\"><img data-x=\"/no\">");
  });

  it("never touches inline script bodies, where / starts a regex or a division", () => {
    const body = '<script>const m = href.match(/[?&]logging=([a-z]*)/); const r = a / b;</script><script src="/app/ui.js"></script>';
    expect(rewriteHtmlAbsolutePaths(body, "/p")).toBe('<script>const m = href.match(/[?&]logging=([a-z]*)/); const r = a / b;</script><script src="/p/app/ui.js"></script>');
  });
});

describe("rewriteCssAbsolutePaths", () => {
  it("rewrites absolute url() and @import, leaving relative ones alone", () => {
    const body = "a{background:url(/img/x.svg)} b{background:url('../y.png')} @import \"/base.css\";";
    expect(rewriteCssAbsolutePaths(body, "/p")).toBe("a{background:url(/p/img/x.svg)} b{background:url('../y.png')} @import \"/p/base.css\";");
  });
});

describe("script bodies", () => {
  it("leaves a bundle untouched, regex literals and all", () => {
    const bundle = 'export const p = d => d.match(/[?&]logging=([A-Za-z0-9._-]*)/);\nconst r = a / b;\n';
    expect(rewriteHtmlAbsolutePaths(bundle, "/p")).toBe(bundle);
    expect(rewriteCssAbsolutePaths(bundle, "/p")).toBe(bundle);
  });
});

describe("runtime proxy websocket tunnel", () => {

  it("tunnels a websocket upgrade to the runtime (noVNC)", async () => {
    const upstream = await fakeRuntime();
    servers.push(upstream.server);
    const wss = new WebSocketServer({ server: upstream.server, path: "/websockify" });
    wss.on("connection", client => {
      client.on("message", data => client.send(`echo:${data.toString()}`));
    });
    const base = await build(upstream.port);
    const client = new WebSocket(`${base.replace("http", "ws")}/api/v1/endpoints/${endpointId}/runtime/6081/websockify`);
    const reply = await new Promise<string>((resolve, reject) => {
      client.on("open", () => client.send("ping"));
      client.on("message", data => resolve(data.toString()));
      client.on("error", reject);
      setTimeout(() => reject(new Error("websocket tunnel timed out")), 5000);
    });
    client.close();
    wss.close();
    expect(reply).toBe("echo:ping");
  });
})
