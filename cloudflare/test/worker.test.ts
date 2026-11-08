import { expect, it, vi } from "vitest";
import worker, { type Env } from "../src";

it("passes ordinary requests to the origin unchanged", async () => {
  const origin: Env["ORIGIN"] = {
    fetch: vi.fn(async () => new Response("origin-ok", { status: 200 })),
  };
  const response = await worker.fetch(new Request("https://site.test/home"), { ORIGIN: origin });

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledOnce();
});
