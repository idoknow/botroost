import { describe, expect, it } from "vitest";
import { asEndpointId } from "@botroost/contracts";
import { runProviderContractSuite } from "@botroost/provider-sdk";
import { FakeProviderAdapter } from "../src/index.js";
describe("fake provider", () => {
  runProviderContractSuite(
    () => new FakeProviderAdapter(),
    {
      test: it,
      assert: expect,
    },
  );
  it("recursively redacts nested objects and arrays", async () => {
    const provider = new FakeProviderAdapter();
    await provider.setup({});
    await provider.configure(asEndpointId("ep"), {
      nested: { password: "secret" },
      values: [{ apiKey: "key" }, { mode: "test" }],
    });
    expect(await provider.observe(asEndpointId("ep"))).toEqual({
      configured: true,
      configuration: {
        nested: { password: "[REDACTED]" },
        values: [{ apiKey: "[REDACTED]" }, { mode: "test" }],
      },
    });
  });
});
