import { useCallback, useEffect, useState } from "react";
import { api, formatDate } from "../api";

interface ActiveBlock {
  sourceIp: string;
  mode: "maze" | "blocked";
  confirmedAt: number;
  expiresAt: number;
}

interface AuditEntry {
  id: string;
  actor_email: string;
  action: string;
  source_ip: string;
  created_at: number;
  outcome: string;
}

export default function Containment() {
  const [blocks, setBlocks] = useState<ActiveBlock[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  const [busyIp, setBusyIp] = useState("");

  const refresh = useCallback(async () => {
    const [active, history] = await Promise.all([
      api<{ blocks: ActiveBlock[] }>("/blocks"),
      api<{ entries: AuditEntry[] }>("/audit?limit=20"),
    ]);
    setBlocks(active.blocks);
    setAudit(history.entries);
  }, []);

  useEffect(() => {
    void refresh().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not load containment");
    });
  }, [refresh]);

  async function unblock(sourceIp: string) {
    if (!window.confirm(`Manually unblock ${sourceIp}? This action is recorded in the audit history.`)) {
      return;
    }
    setBusyIp(sourceIp);
    setError("");
    try {
      await api(`/blocks/${encodeURIComponent(sourceIp)}/unblock`, { method: "POST" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unblock failed");
    } finally {
      setBusyIp("");
    }
  }

  return (
    <section className="stack">
      <div className="page-intro">
        <div>
          <span className="eyebrow">RESPONSE</span>
          <h2>Containment status</h2>
          <p>Active maze and block state, scheduled expiry and operator actions.</p>
        </div>
        <button className="button button-secondary" onClick={() => void refresh()}>Refresh</button>
      </div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="card table-card">
        <div className="card-heading">
          <div><h3>Active containment</h3><p>Containment expires automatically; manual unblocks are audited.</p></div>
          <span className="count-pill">{blocks.length} active</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Source IP</th><th>State</th><th>Confirmed</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {blocks.map((block) => (
                <tr key={block.sourceIp}>
                  <td className="mono">{block.sourceIp}</td>
                  <td><span className={`state-pill ${block.mode === "blocked" ? "blocked" : "pending"}`}>
                    {block.mode === "blocked" ? "Blocked" : "Maze"}
                  </span></td>
                  <td>{formatDate(block.confirmedAt)}</td>
                  <td>{formatDate(block.expiresAt)}</td>
                  <td>
                    <button
                      className="button button-danger"
                      disabled={busyIp === block.sourceIp}
                      onClick={() => void unblock(block.sourceIp)}
                    >
                      {busyIp === block.sourceIp ? "Unblocking…" : "Unblock"}
                    </button>
                  </td>
                </tr>
              ))}
              {blocks.length === 0 && <tr><td className="empty-row" colSpan={5}>No active containment.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card table-card">
        <div className="card-heading"><div><h3>Operator audit</h3><p>Manual unblock history</p></div></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Action</th><th>Source</th><th>Operator</th><th>Time</th><th>Result</th></tr></thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td>Manual unblock</td>
                  <td className="mono">{entry.source_ip}</td>
                  <td>{entry.actor_email}</td>
                  <td>{formatDate(entry.created_at)}</td>
                  <td>{entry.outcome}</td>
                </tr>
              ))}
              {audit.length === 0 && <tr><td className="empty-row" colSpan={5}>No operator actions recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
