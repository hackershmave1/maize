import { expect, it } from "vitest";
import {
  CHAIN_HOPS,
  CHAIN_LENGTH,
  hopToken,
  matchChainHop,
  renderHop,
} from "../src/rabbit-hole";

const secret = "unit-test-verifier-material";
const origin = "https://site.test";

it("defines ten hops with unique paths after the bait API", () => {
  expect(CHAIN_LENGTH).toBe(10);
  expect(CHAIN_HOPS.map((hop) => hop.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new Set(CHAIN_HOPS.map((hop) => hop.path)).size).toBe(9);
  expect(CHAIN_HOPS.map((hop) => hop.route)).toEqual(
    [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `hop-${n}`),
  );
});

it("derives distinct deterministic 64-hex tokens per hop", async () => {
  const tokens = await Promise.all([2, 3, 10].map((n) => hopToken(secret, n)));
  expect(tokens.every((token) => /^[a-f0-9]{64}$/.test(token))).toBe(true);
  expect(new Set(tokens).size).toBe(3);
  expect(await hopToken(secret, 2)).toBe(tokens[0]);
  expect(await hopToken("other-secret", 2)).not.toBe(tokens[0]);
});

it("each hop below ten leaks the next endpoint and its token", async () => {
  for (let hop = 1; hop < CHAIN_LENGTH; hop += 1) {
    const body = await (await renderHop(hop, origin, secret)).json() as {
      data: unknown;
      next: { endpoint: string; authorization: string };
    };
    const next = CHAIN_HOPS.find((candidate) => candidate.number === hop + 1)!;
    expect(body.data).toBeTruthy();
    expect(body.next.endpoint).toBe(`${origin}${next.path}`);
    expect(body.next.authorization).toBe(`Bearer ${await hopToken(secret, hop + 1)}`);
  }
});

it("the final hop has data and no next lead", async () => {
  const response = await renderHop(CHAIN_LENGTH, origin, secret);
  const body = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body.data).toBeTruthy();
  expect(body.next).toBeUndefined();
});

it("renders the same hop identically and keeps hostnames on example.invalid", async () => {
  const first = await (await renderHop(8, origin, secret)).text();
  const second = await (await renderHop(8, origin, secret)).text();
  expect(first).toBe(second);
  const hosts = [...first.matchAll(/"host":"([^"]+)"/g)].map((match) => match[1]);
  expect(hosts.length).toBeGreaterThan(0);
  expect(hosts.every((host) => host.endsWith(".example.invalid"))).toBe(true);
});

it("matches a hop only with its own bearer token", async () => {
  const hop3 = CHAIN_HOPS.find((hop) => hop.number === 3)!;
  const request = (token: string | null, path = hop3.path) => new Request(`${origin}${path}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });

  expect(await matchChainHop(request(await hopToken(secret, 3)), secret)).toBe(3);
  expect(await matchChainHop(request(await hopToken(secret, 4)), secret)).toBeNull();
  expect(await matchChainHop(request(null), secret)).toBeNull();
  expect(await matchChainHop(request("zz"), secret)).toBeNull();
  expect(await matchChainHop(request(await hopToken(secret, 3), "/nope"), secret)).toBeNull();
  expect(await matchChainHop(request(await hopToken(secret, 3)), undefined)).toBeNull();
});
