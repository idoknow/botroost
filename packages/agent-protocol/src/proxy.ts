import { z } from "zod";

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => {
    if (value.includes(":")) {
      // Bare IPv6 form is accepted; the environment builder re-brackets it.
      return z.ipv6().safeParse(value).success;
    }
    return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) && !value.includes("..");
  }, "host must be a hostname or IP address");

export const proxyConfigurationSchema = z
  .object({
    protocol: z.enum(["http", "https", "socks5"]),
    host: hostSchema,
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(128).optional(),
    password: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.username !== undefined && value.password === undefined) {
      ctx.addIssue({ code: "custom", message: "username requires a password", path: ["password"] });
    }
    if (value.password !== undefined && value.username === undefined) {
      ctx.addIssue({ code: "custom", message: "password requires a username", path: ["username"] });
    }
  });

export type ProxyConfiguration = z.infer<typeof proxyConfigurationSchema>;

const noProxyTargets = "localhost,127.0.0.1,::1";

const bracketHost = (host: string): string => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

const schemeFor = (protocol: ProxyConfiguration["protocol"]): string => (protocol === "https" ? "https" : protocol === "socks5" ? "socks5" : "http");

/** Standard proxy URL understood by Node runtimes and most language HTTP stacks. */
export function proxyUrl(config: ProxyConfiguration): string {
  const scheme = schemeFor(config.protocol);
  const host = bracketHost(config.host);
  const credentials =
    config.username !== undefined && config.password !== undefined
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
      : "";
  return `${scheme}://${credentials}${host}:${config.port}`;
}

/**
 * Container-level proxy environment for the protocol endpoint workload.
 * Returns undefined when no proxy is configured, so callers can skip injection entirely.
 */
export function applyProxyEnvironment(
  config: unknown,
  base: Record<string, string> = {},
): Record<string, string> | undefined {
  const parsed = proxyConfigurationSchema.safeParse(config);
  if (!parsed.success) return undefined;
  const url = proxyUrl(parsed.data);
  return {
    ...base,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: noProxyTargets,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    no_proxy: noProxyTargets,
  };
}

/** Client-facing projection: credentials never leave the control plane in plaintext. */
export function sanitizeProxyConfiguration(config: unknown): Record<string, unknown> | null {
  const parsed = proxyConfigurationSchema.safeParse(config);
  if (!parsed.success) return null;
  const proxy = parsed.data;
  return {
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.username !== undefined ? { username: proxy.username } : {}),
    ...(proxy.username !== undefined ? { passwordConfigured: true } : {}),
  };
}
