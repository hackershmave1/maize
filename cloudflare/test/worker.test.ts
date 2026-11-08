import { expect, it, vi } from "vitest";
import worker, { type Env } from "../src";

it("passes ordinary requests to the origin unchanged", async () => {
  const origin: Env["ORIGIN"] = {
    fetch: vi.fn(async () => new Response("origin-ok", { status: 200 })),
  };
  const request = new Request("https://site.test/home?view=full");
  const response = await worker.fetch(request, { ORIGIN: origin });

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledOnce();
  expect(origin.fetch).toHaveBeenCalledWith(request);
});

it("handles the .env lure without sending it to the origin", async () => {
  const origin: Env["ORIGIN"] = {
    fetch: vi.fn(async () => new Response("origin-ok", { status: 200 })),
  };
  const response = await worker.fetch(new Request("https://site.test/.env"), {
    ORIGIN: origin,
    LURE_KEY_SECRET: "unit-test-verifier-material",
    BAIT_API_PATH: "/api/private/account",
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/^API_KEY=[a-f0-9]{64}$/m);
  expect(origin.fetch).not.toHaveBeenCalled();
});
