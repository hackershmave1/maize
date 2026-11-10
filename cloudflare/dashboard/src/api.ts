export interface EventRecord {
  id: string;
  installationId: string;
  type: string;
  route: string | null;
  sourceIp: string | null;
  confirmed: boolean;
  createdAt: number;
}

export interface RuntimeSettings {
  luresEnabled: boolean;
  mazeDurationMinutes: number;
  blockDurationHours: number;
  responseBudget: number;
  alertGroupingMinutes: number;
  retentionDays: number;
}

export interface DeploymentSettings {
  adminHostname: string | null;
  publicHostname: string | null;
  adminRoute: string | null;
  publicRoute: string | null;
  accessTeamDomain: string | null;
  accessAudienceConfigured: boolean;
  webhookDestinationHost: string | null;
  managedBy: string;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function formatDate(timestamp: number | null): string {
  return timestamp === null ? "—" : new Date(timestamp).toLocaleString();
}
