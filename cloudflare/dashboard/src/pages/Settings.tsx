import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  type DeploymentSettings,
  type RuntimeSettings as RuntimeSettingsShape,
} from "../api";

const defaults: RuntimeSettingsShape = {
  luresEnabled: true,
  mazeDurationMinutes: 15,
  blockDurationHours: 24,
  responseBudget: 100,
  alertGroupingMinutes: 5,
  retentionDays: 30,
};

interface SettingsResponse extends RuntimeSettingsShape {
  deployment: DeploymentSettings;
}

interface AllowlistResponse {
  sources: string[];
  configuredSources: string[];
}

export default function Settings() {
  const [settings, setSettings] = useState<RuntimeSettingsShape>(defaults);
  const [deployment, setDeployment] = useState<DeploymentSettings | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [configuredSources, setConfiguredSources] = useState<string[]>([]);
  const [newIp, setNewIp] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const [saved, allowlist] = await Promise.all([
      api<SettingsResponse>("/settings"),
      api<AllowlistResponse>("/allowlist"),
    ]);
    setSettings({
      luresEnabled: saved.luresEnabled,
      mazeDurationMinutes: saved.mazeDurationMinutes,
      blockDurationHours: saved.blockDurationHours,
      responseBudget: saved.responseBudget,
      alertGroupingMinutes: saved.alertGroupingMinutes,
      retentionDays: saved.retentionDays,
    });
    setDeployment(saved.deployment);
    setSources(allowlist.sources);
    setConfiguredSources(allowlist.configuredSources);
  }

  useEffect(() => {
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not load settings");
    });
  }, []);

  function updateNumber(key: keyof RuntimeSettingsShape, value: string) {
    setSettings((previous) => ({ ...previous, [key]: Number(value) }));
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await api<RuntimeSettingsShape>("/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      setSettings(saved);
      setNotice("Runtime controls saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Settings could not be saved");
    } finally {
      setSaving(false);
    }
  }

  async function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      await api("/allowlist", { method: "POST", body: JSON.stringify({ ip: newIp }) });
      setNewIp("");
      await load();
      setNotice("Allowlist updated.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Address could not be added");
    }
  }

  async function removeSource(ip: string) {
    setError("");
    try {
      await api(`/allowlist/${encodeURIComponent(ip)}`, { method: "DELETE" });
      await load();
      setNotice("Allowlist updated.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Address could not be removed");
    }
  }

  return (
    <section className="stack">
      <div className="page-intro">
        <div>
          <span className="eyebrow">POLICY</span>
          <h2>Runtime controls</h2>
          <p>Bounded settings take effect without changing the deployed Worker.</p>
        </div>
      </div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {notice && <div className="notice notice-success" role="status">{notice}</div>}

      <form className="card settings-card" onSubmit={(event) => void saveSettings(event)}>
        <div className="card-heading">
          <div><h3>Response behavior</h3><p>Validated bounds are enforced by the Worker.</p></div>
          <button className="button button-primary" disabled={saving}>
            {saving ? "Saving…" : "Save controls"}
          </button>
        </div>
        <label className="toggle-row">
          <span><strong>Serve configured lures</strong><small>Disabled lures return a generic not-found response.</small></span>
          <input
            checked={settings.luresEnabled}
            onChange={(event) => setSettings({ ...settings, luresEnabled: event.target.checked })}
            type="checkbox"
          />
        </label>
        <div className="field-grid">
          <NumberField label="Maze duration" suffix="minutes" value={settings.mazeDurationMinutes}
            min={1} max={120} onChange={(value) => updateNumber("mazeDurationMinutes", value)} />
          <NumberField label="Block duration" suffix="hours" value={settings.blockDurationHours}
            min={1} max={168} onChange={(value) => updateNumber("blockDurationHours", value)} />
          <NumberField label="Maze response budget" suffix="responses" value={settings.responseBudget}
            min={1} max={10000} onChange={(value) => updateNumber("responseBudget", value)} />
          <NumberField label="Alert grouping" suffix="minutes" value={settings.alertGroupingMinutes}
            min={1} max={60} onChange={(value) => updateNumber("alertGroupingMinutes", value)} />
          <NumberField label="Event/IP retention" suffix="days" value={settings.retentionDays}
            min={1} max={30} onChange={(value) => updateNumber("retentionDays", value)} />
        </div>
      </form>

      <div className="card settings-card">
        <div className="card-heading">
          <div><h3>Source allowlist</h3><p>Allowlisted addresses bypass quarantine and blocking.</p></div>
        </div>
        <form className="inline-form" onSubmit={(event) => void addSource(event)}>
          <label className="grow">
            <span>IP address</span>
            <input
              autoComplete="off"
              inputMode="url"
              placeholder="203.0.113.10 or 2001:db8::1"
              value={newIp}
              onChange={(event) => setNewIp(event.target.value)}
            />
          </label>
          <button className="button button-secondary" disabled={!newIp.trim()}>Add address</button>
        </form>
        <div className="allowlist">
          {[...configuredSources.map((ip) => ({ ip, managed: true })), ...sources.map((ip) => ({ ip, managed: false }))]
            .map(({ ip, managed }) => (
              <div className="allowlist-row" key={`${managed ? "managed" : "runtime"}-${ip}`}>
                <span className="mono">{ip}</span>
                {managed
                  ? <span className="readonly-tag">Terraform managed</span>
                  : <button className="text-button danger-text" onClick={() => void removeSource(ip)}>Remove</button>}
              </div>
            ))}
          {sources.length === 0 && configuredSources.length === 0 && (
            <p className="muted">No sources on the allowlist.</p>
          )}
        </div>
      </div>

      <div className="card settings-card">
        <div className="card-heading">
          <div><h3>Deployment-managed configuration</h3><p>These values are read-only and managed in Terraform.</p></div>
          <span className="readonly-tag">{deployment?.managedBy ?? "Terraform"}</span>
        </div>
        <dl className="readonly-grid">
          <div><dt>Admin hostname</dt><dd>{deployment?.adminHostname ?? "Not configured"}</dd></div>
          <div><dt>Admin Worker route</dt><dd>{deployment?.adminRoute ?? "Not configured"}</dd></div>
          <div><dt>Protected site</dt><dd>{deployment?.publicHostname ?? "Not configured"}</dd></div>
          <div><dt>Public Worker route</dt><dd>{deployment?.publicRoute ?? "Not configured"}</dd></div>
          <div><dt>Access team</dt><dd>{deployment?.accessTeamDomain ?? "Not configured"}</dd></div>
          <div><dt>Access audience</dt><dd>{deployment?.accessAudienceConfigured ? "Configured" : "Not configured"}</dd></div>
          <div><dt>Webhook destination</dt><dd>{deployment?.webhookDestinationHost ?? "Not configured"}</dd></div>
        </dl>
      </div>
    </section>
  );
}

function NumberField(props: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="number-field">
      <span>{props.label}</span>
      <span className="input-with-suffix">
        <input
          max={props.max}
          min={props.min}
          onChange={(event) => props.onChange(event.target.value)}
          required
          type="number"
          value={props.value}
        />
        <small>{props.suffix}</small>
      </span>
      <small className="field-hint">Range: {props.min}–{props.max}</small>
    </label>
  );
}
