import { describe, expect, it } from "vitest";
import { createProxyFormState, toProxyPayload, type ProxyView } from "../src/proxy-editor";

const configured: ProxyView = { protocol: "socks5", host: "p.internal", port: 1080, username: "alice", passwordConfigured: true };

describe("proxy editor state", () => {
  it("starts empty for endpoints without a proxy and shows it as unconfigured", () => {
    const state = createProxyFormState(null);
    expect(state).toEqual({ protocol: "http", host: "", port: "", username: "", password: "", configured: false, dirty: false });
  });

  it("hydrates from a configured proxy without exposing the password and marks it configured", () => {
    const state = createProxyFormState(configured);
    expect(state.configured).toBe(true);
    expect(state.password).toBe("");
    expect(state.protocol).toBe("socks5");
    expect(state.port).toBe("1080");
  });

  it("stays clean on a fresh state and tolerates immutable spreads for edits", () => {
    const state = createProxyFormState(configured);
    expect(state.dirty).toBe(false);
    const edited = { ...state, host: "changed.internal", dirty: true };
    expect(edited.dirty).toBe(true);
    expect(state.host).toBe("p.internal");
  });

  it("builds a save payload keeping the stored password when left blank", () => {
    const state = { ...createProxyFormState(configured), host: "next.internal", dirty: true };
    expect(toProxyPayload(state)).toEqual({ protocol: "socks5", host: "next.internal", port: 1080, username: "alice" });
  });

  it("includes a newly typed password in the payload", () => {
    const state = { ...createProxyFormState(configured), password: "new-secret", dirty: true };
    expect(toProxyPayload(state)).toMatchObject({ password: "new-secret" });
  });

  it("builds a null payload when every field is cleared", () => {
    const state = { ...createProxyFormState(null), dirty: true };
    expect(toProxyPayload(state)).toBeNull();
  });

  it("refuses to save an incomplete form", () => {
    expect(() => toProxyPayload({ ...createProxyFormState(null), host: "10.0.0.1", dirty: true })).toThrow(/port/);
    expect(() => toProxyPayload({ ...createProxyFormState(null), port: "8080", dirty: true })).toThrow(/host/);
    expect(() => toProxyPayload({ ...createProxyFormState(null), host: "h", port: "0", dirty: true })).toThrow(/port/);
    expect(() => toProxyPayload({ ...createProxyFormState(null), host: "h", port: "8080", username: "u", dirty: true })).toThrow(/password/);
  });
});
