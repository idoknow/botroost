import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { EndpointDetail } from "../src/pages";
import type { Session } from "../src/types";

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg role="img" aria-label="NapCat QR code"><title>{value}</title></svg>,
}));

const session: Session = {
  user: { id: "user-1", email: "operator@example.test", name: "Operator" },
  workspace: { id: "ws-1", name: "Primary" },
  role: "operator",
  permissions: ["endpoint:read", "endpoint:update", "endpoint:start", "endpoint:stop", "endpoint:restart"],
  capabilities: { operations: ["start", "stop", "restart"], providers: { napcat: { enabled: true } }, configurationSchemas: {} },
};

describe("NapCat endpoint UI", () => {
  it("shows an online account dashboard, hides QR login, and renders OneBot resources", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const path = new URL(url, "https://app.test").pathname;
      if (path === "/api/v1/endpoints/endpoint-1") {
        return new Response(JSON.stringify({
          id: "endpoint-1",
          name: "Operator QQ",
          providerId: "napcat",
          node: { id: "node-1", name: "agent-1" },
          generation: 0,
          desired: { state: "stopped" },
          status: { node: "online", runtime: "ready", provider: "available", protocol: "connected", convergence: "converged" },
          activeOperationId: null,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/v1/endpoints/endpoint-1/napcat/login-qrcode") {
        return new Response(JSON.stringify({ qrcode: "otpauth://qq-login" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/v1/endpoints/endpoint-1/napcat/status") {
        return new Response(JSON.stringify({
          qq: { uin: "12345", nickname: "Operator QQ" },
          onebot: { status: { online: true }, loginInfo: { user_id: 12345, nickname: "Operator QQ" }, friends:[{user_id:7,nickname:"Alice",remark:"Core"}], groups:[{group_id:8,group_name:"Botroost users",member_count:42}], version:{app_name:"NapCat.OneBot11",app_version:"4.18.19"}, config:{websocketClients:[{name:"LangBot",enable:true,url:"wss://bot.example/ws",tokenConfigured:true}],websocketServers:[]} },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    const previous = globalThis.fetch;
    globalThis.fetch = fetcher as typeof fetch;
    try {
      render(
        <MantineProvider>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MemoryRouter initialEntries={["/endpoints/endpoint-1"]}>
              <Routes><Route path="/endpoints/:id" element={<EndpointDetail session={session} />} /></Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </MantineProvider>,
      );

      expect(await screen.findByText("QQ account")).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "NapCat QR code" })).not.toBeInTheDocument();
      await screen.findByText("Alice");
      expect(screen.queryByRole("button", { name: "Refresh QR code" })).not.toBeInTheDocument();
      expect(await screen.findByText("Alice")).toBeInTheDocument();
      expect(await screen.findByText("Botroost users")).toBeInTheDocument();
      expect(await screen.findByText("4.18.19")).toBeInTheDocument();
      expect(screen.getAllByText("Protocol service").length).toBeGreaterThan(0);
      expect(screen.getByText("OneBot 11")).toBeInTheDocument();
      expect(screen.getByText("NapCat.OneBot11")).toBeInTheDocument();
      expect(screen.queryByText("Runtime")).not.toBeInTheDocument();
      expect(await screen.findByDisplayValue("wss://bot.example/ws")).toBeInTheDocument();
      expect(await screen.findByText("API available")).toBeInTheDocument();
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("lets the operator refresh an expired QR code and displays the replacement", async () => {
    let qrcode = "qr-expired";
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "https://app.test").pathname;
      if (path === "/api/v1/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf" }));
      if (path === "/api/v1/endpoints/endpoint-1") return new Response(JSON.stringify({ id:"endpoint-1",name:"Operator QQ",providerId:"napcat",node:{id:"node-1",name:"agent-1"},generation:1,desired:{state:"running"},status:{node:"online",runtime:"ready",provider:"available",protocol:"disconnected",convergence:"reconciling"},activeOperationId:null }), { headers:{"content-type":"application/json"} });
      if (path.endsWith("/napcat/login-qrcode") && init?.method !== "POST") return new Response(JSON.stringify({ qrcode }), { headers:{"content-type":"application/json"} });
      if (path.endsWith("/napcat/status")) return new Response(JSON.stringify({ qq:null,onebot:null }), { headers:{"content-type":"application/json"} });
      if (path.endsWith("/napcat/login-qrcode") && init?.method === "POST") { qrcode = "qr-fresh"; return new Response(JSON.stringify({ id:"refresh-op",endpointId:"endpoint-1",status:"queued" }), { status:202,headers:{"content-type":"application/json"} }); }
      if (path === "/api/v1/operations/refresh-op") return new Response(JSON.stringify({ id:"refresh-op",endpointId:"endpoint-1",status:"succeeded" }), { headers:{"content-type":"application/json"} });
      return new Response("{}", { status:404 });
    });
    const previous=globalThis.fetch;globalThis.fetch=fetcher as typeof fetch;
    try {
      render(<MantineProvider><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={["/endpoints/endpoint-1"]}><Routes><Route path="/endpoints/:id" element={<EndpointDetail session={session}/>} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
      expect(await screen.findByTitle("qr-expired")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button",{name:"Refresh QR code"}));
      expect(await screen.findByTitle("qr-fresh")).toBeInTheDocument();
    } finally { globalThis.fetch=previous; }
  });

  it("shows bounded NapCat container logs in the endpoint console", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "https://app.test").pathname;
      if (path === "/api/v1/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf" }));
      if (path === "/api/v1/endpoints/endpoint-1") return new Response(JSON.stringify({ id:"endpoint-1",name:"Operator QQ",providerId:"napcat",node:{id:"node-1",name:"agent-1"},generation:1,desired:{state:"running"},status:{node:"online",runtime:"ready",provider:"available",protocol:"disconnected",convergence:"reconciling"},activeOperationId:null }), { headers:{"content-type":"application/json"} });
      if (path.endsWith("/napcat/login-qrcode")) return new Response(JSON.stringify({ qrcode:"qr" }), { headers:{"content-type":"application/json"} });
      if (path.endsWith("/napcat/status")) return new Response(JSON.stringify({ qq:null,onebot:null }), { headers:{"content-type":"application/json"} });
      if (path.endsWith("/napcat/container-logs") && init?.method === "POST") return new Response(JSON.stringify({ id:"logs-op",endpointId:"endpoint-1",status:"queued" }), { status:202,headers:{"content-type":"application/json"} });
      if (path === "/api/v1/operations/logs-op") return new Response(JSON.stringify({ id:"logs-op",endpointId:"endpoint-1",status:"succeeded",result:{metadata:{logs:{text:"NapCat ready\\nToken=[REDACTED]",tail:250,sinceSeconds:900}}} }), { headers:{"content-type":"application/json"} });
      return new Response("{}", { status:404 });
    });
    const previous=globalThis.fetch;globalThis.fetch=fetcher as typeof fetch;
    try {
      render(<MantineProvider><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={["/endpoints/endpoint-1"]}><Routes><Route path="/endpoints/:id" element={<EndpointDetail session={session}/>} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
      await userEvent.click(await screen.findByRole("button",{name:"Load container logs"}));
      expect(await screen.findByText(/NapCat ready/)).toBeInTheDocument();
      expect(screen.getByText(/Token=\[REDACTED\]/)).toBeInTheDocument();
    } finally { globalThis.fetch=previous; }
  });
});
