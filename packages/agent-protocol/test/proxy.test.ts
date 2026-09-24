import { describe, expect, it } from "vitest";
import { applyProxyEnvironment, proxyConfigurationSchema, proxyUrl, sanitizeProxyConfiguration } from "../src/proxy.js";

describe("endpoint proxy configuration", () => {
  it("accepts a minimal http proxy", () => {
    const parsed = proxyConfigurationSchema.parse({ protocol: "http", host: "10.0.0.1", port: 8080 });
    expect(parsed).toEqual({ protocol: "http", host: "10.0.0.1", port: 8080 });
  });

  it("accepts socks5 with credentials", () => {
    const parsed = proxyConfigurationSchema.parse({
      protocol: "socks5",
      host: "proxy.example.com",
      port: 1080,
      username: "alice",
      password: "s3cret",
    });
    expect(parsed).toEqual({ protocol: "socks5", host: "proxy.example.com", port: 1080, username: "alice", password: "s3cret" });
  });

  it("rejects unknown protocols and invalid ports", () => {
    expect(proxyConfigurationSchema.safeParse({ protocol: "ftp", host: "h", port: 8080 }).success).toBe(false);
    expect(proxyConfigurationSchema.safeParse({ protocol: "http", host: "h", port: 0 }).success).toBe(false);
    expect(proxyConfigurationSchema.safeParse({ protocol: "http", host: "h", port: 65536 }).success).toBe(false);
  });

  it("accepts IPv6 hosts and rejects unknown fields", () => {
    const parsed = proxyConfigurationSchema.parse({ protocol: "http", host: "2001:db8::1", port: 8080 });
    expect(parsed.host).toBe("2001:db8::1");
    expect(proxyConfigurationSchema.safeParse({ protocol: "http", host: "h", port: 1, extra: true }).success).toBe(false);
  });

  it("redacts credentials in the client-facing projection", () => {
    const config = proxyConfigurationSchema.parse({
      protocol: "socks5",
      host: "p.internal",
      port: 1080,
      username: "alice",
      password: "s3cret",
    });
    const view = sanitizeProxyConfiguration(config);
    expect(view).toEqual({ protocol: "socks5", host: "p.internal", port: 1080, username: "alice", passwordConfigured: true });
    expect(JSON.stringify(view)).not.toContain("s3cret");
  });

  it("returns null projection for an invalid stored config", () => {
    expect(sanitizeProxyConfiguration({ protocol: "bogus" })).toBeNull();
  });

  it("builds standard proxy environment variables with bracketed IPv6 hosts", () => {
    const env = applyProxyEnvironment(
      { protocol: "http", host: "2001:db8::1", port: 8080 },
      { ["HTTP_PROXY"]: "http://leak:1" },
    );
    expect(env).toEqual({
      HTTP_PROXY: "http://[2001:db8::1]:8080",
      HTTPS_PROXY: "http://[2001:db8::1]:8080",
      ALL_PROXY: "http://[2001:db8::1]:8080",
      NO_PROXY: "localhost,127.0.0.1,::1",
      http_proxy: "http://[2001:db8::1]:8080",
      https_proxy: "http://[2001:db8::1]:8080",
      all_proxy: "http://[2001:db8::1]:8080",
      no_proxy: "localhost,127.0.0.1,::1",
    });
  });

  it("uses the socks5 scheme for socks proxies in proxy URLs", () => {
    const env = applyProxyEnvironment({ protocol: "socks5", host: "p.internal", port: 1080, username: "u", password: "p" });
    expect(env!.ALL_PROXY).toBe("socks5://u:p@p.internal:1080");
    expect(env!.HTTP_PROXY).toBe("socks5://u:p@p.internal:1080");
  });

  it("returns undefined environment when the proxy is absent or invalid", () => {
    expect(applyProxyEnvironment(null, {})).toBeUndefined();
    expect(applyProxyEnvironment(undefined, {})).toBeUndefined();
    expect(applyProxyEnvironment({ protocol: "nope" }, {})).toBeUndefined();
  });

  it("formats https proxy URLs with the https scheme", () => {
    expect(proxyUrl({ protocol: "https", host: "h", port: 443 })).toBe("https://h:443");
  });
});
