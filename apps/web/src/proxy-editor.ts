export type ProxyProtocol = "http" | "https" | "socks5";

/** Client-facing proxy view returned by the API: the password itself is never included. */
export type ProxyView = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  passwordConfigured?: boolean;
};

export type ProxyPayload = { protocol: ProxyProtocol; host: string; port: number; username?: string; password?: string };

/** Plain form state: safe to spread for immutable React updates. */
export type ProxyFormState = {
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  /** True when a proxy is already stored server-side (password redacted by the API). */
  configured: boolean;
  dirty: boolean;
};

export function createProxyFormState(view?: ProxyView | null): ProxyFormState {
  return {
    protocol: view?.protocol ?? "http",
    host: view?.host ?? "",
    port: view?.port !== undefined ? String(view.port) : "",
    username: view?.username ?? "",
    password: "",
    configured: Boolean(view),
    dirty: false,
  };
}

/**
 * Build the PUT /proxy payload from the current form state.
 * Throws on an incomplete form so callers can surface a validation message.
 * An empty password on a configured proxy keeps the stored one server-side.
 */
export function toProxyPayload(state: ProxyFormState): ProxyPayload | null {
  const host = state.host.trim();
  const port = Number(state.port);
  const username = state.username.trim();
  if (!host && !state.port && !username && !state.password) return null;
  if (!host) throw new Error("proxy host is required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("proxy port must be between 1 and 65535");
  const password = state.password.length ? state.password : undefined;
  if (username && !password && !state.configured) throw new Error("proxy username requires a password");
  return {
    protocol: state.protocol,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}
