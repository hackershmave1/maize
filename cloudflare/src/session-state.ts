export const MAZE_DURATION_MS = 15 * 60 * 1_000;
export const BLOCK_DURATION_MS = 24 * 60 * 60 * 1_000;
export const MAX_MAZE_DURATION_MS = 120 * 60 * 1_000;
export const MAX_BLOCK_DURATION_MS = 168 * 60 * 60 * 1_000;
export const MAX_CONTAINMENT_DURATION_MS =
  MAX_MAZE_DURATION_MS + MAX_BLOCK_DURATION_MS;

export type SessionMode = "ordinary" | "maze" | "blocked";

export interface PersistedSessionState {
  confirmedAt: number | null;
  mazeUntil: number | null;
  blockUntil: number | null;
  mazeRequests: number;
  throttledRequests: number;
  chainDepth: number;
}

export interface AgentSessionSnapshot extends PersistedSessionState {
  mode: SessionMode;
}

export interface MazeRequestResult {
  state: AgentSessionSnapshot;
  throttled: boolean;
}

export interface ChainAdvanceResult {
  accepted: boolean;
  state: AgentSessionSnapshot;
}

export function emptySessionState(): PersistedSessionState {
  return {
    confirmedAt: null,
    mazeUntil: null,
    blockUntil: null,
    mazeRequests: 0,
    throttledRequests: 0,
    chainDepth: 0,
  };
}

export function getSessionMode(
  state: PersistedSessionState,
  now: number,
): SessionMode {
  if (state.confirmedAt === null || state.mazeUntil === null || state.blockUntil === null) {
    return "ordinary";
  }
  if (now < state.mazeUntil) return "maze";
  if (now < state.blockUntil) return "blocked";
  return "ordinary";
}

export function snapshotSessionState(
  state: PersistedSessionState,
  now: number,
): AgentSessionSnapshot {
  return { ...state, mode: getSessionMode(state, now) };
}

export function expireSessionState(
  state: PersistedSessionState,
  now: number,
): PersistedSessionState {
  return getSessionMode(state, now) === "ordinary" && state.confirmedAt !== null
    ? emptySessionState()
    : state;
}

export function normalizeSourceIp(value: string | null): string | null {
  if (value === null) return null;
  const address = value.trim().toLowerCase();
  if (isIpv4(address)) {
    return address.split(".").map((part) => String(Number(part))).join(".");
  }
  return normalizeIpv6(address);
}

export async function deriveAgentSessionName(
  installationId: string,
  sourceIp: string,
  hashSecret: string,
): Promise<string> {
  const normalizedIp = normalizeSourceIp(sourceIp);
  if (!installationId || !normalizedIp || !hashSecret) {
    throw new Error("Agent session identity configuration is incomplete");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hashSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(
    `moqesh-agent-session-v1\u0000${installationId}\u0000${normalizedIp}`,
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) <= 255
  );
}

function normalizeIpv6(value: string): string | null {
  if (!value.includes(":") || value.includes("%") || !/^[0-9a-f:.]+$/.test(value)) {
    return null;
  }

  let address = value;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1);
    if (!isIpv4(ipv4)) return null;
    const [a, b, c, d] = ipv4.split(".").map(Number);
    address = `${address.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const doubleColon = address.indexOf("::");
  if (doubleColon !== -1 && address.indexOf("::", doubleColon + 2) !== -1) return null;

  const leftText = doubleColon === -1 ? address : address.slice(0, doubleColon);
  const rightText = doubleColon === -1 ? "" : address.slice(doubleColon + 2);
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const explicit = [...left, ...right];
  if (
    explicit.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    || (doubleColon === -1 && explicit.length !== 8)
    || (doubleColon !== -1 && explicit.length >= 8)
  ) {
    return null;
  }

  const groups = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array(8 - explicit.length).fill(0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];

  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }

  const parts = groups.map((group) => group.toString(16));
  if (bestStart === -1) return parts.join(":");
  const leftPart = parts.slice(0, bestStart).join(":");
  const rightPart = parts.slice(bestStart + bestLength).join(":");
  return `${leftPart}::${rightPart}`;
}
