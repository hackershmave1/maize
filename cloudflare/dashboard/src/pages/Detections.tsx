import { useEffect, useState } from "react";
import { api, formatDate, type EventRecord } from "../api";

interface EventListResponse {
  events: EventRecord[];
  nextCursor: string | null;
}

function eventLabel(type: string): string {
  return type.replaceAll("_", " ");
}

export default function Detections() {
  const [confirmed, setConfirmed] = useState("all");
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<EventRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setCursor(null);
    setSelected(null);
  }, [confirmed]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const filter = confirmed === "all" ? "" : `&confirmed=${confirmed}`;
    const page = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    void api<EventListResponse>(`/events?limit=50${filter}${page}`)
      .then((response) => {
        if (!active) return;
        setEvents((current) => cursor ? [...current, ...response.events] : response.events);
        setNextCursor(response.nextCursor);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load events");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [confirmed, cursor]);

  async function showDetails(event: EventRecord) {
    setSelected(event);
    setError("");
    try {
      const detail = await api<{ event: EventRecord }>(`/events/${encodeURIComponent(event.id)}`);
      setSelected(detail.event);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load event details");
    }
  }

  return (
    <section className="stack">
      <div className="page-intro">
        <div>
          <span className="eyebrow">SIGNALS</span>
          <h2>Detection history</h2>
          <p>Configured lure and containment events. Ordinary requests are not recorded.</p>
        </div>
        <label className="filter-control">
          <span>Confirmation</span>
          <select value={confirmed} onChange={(event) => setConfirmed(event.target.value)}>
            <option value="all">All events</option>
            <option value="false">Unconfirmed</option>
            <option value="true">Confirmed</option>
          </select>
        </label>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="card table-card">
        <div className="card-heading">
          <div>
            <h3>Recent events</h3>
            <p>Newest first · retained for the configured window</p>
          </div>
          <span className="count-pill">{events.length} shown</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Event</th><th>Source</th><th>Route</th><th>State</th><th>Time</th><th /></tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="event-name">{eventLabel(event.type)}</td>
                  <td className="mono">{event.sourceIp ?? "Unknown"}</td>
                  <td>{event.route ?? "—"}</td>
                  <td><span className={`state-pill ${event.confirmed ? "confirmed" : "pending"}`}>
                    {event.confirmed ? "Confirmed" : "Unconfirmed"}
                  </span></td>
                  <td>{formatDate(event.createdAt)}</td>
                  <td>
                    <button className="text-button" onClick={() => void showDetails(event)}>
                      Details
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && events.length === 0 && (
                <tr><td className="empty-row" colSpan={6}>No matching detections.</td></tr>
              )}
              {loading && <tr><td className="empty-row" colSpan={6}>Loading events…</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <span>{nextCursor ? "More events available" : "End of event history"}</span>
          <button
            className="button button-secondary"
            disabled={!nextCursor || loading}
            onClick={() => setCursor(nextCursor)}
          >
            Load next page
          </button>
        </div>
      </div>

      {selected && (
        <div className="card detail-card">
          <div className="card-heading">
            <div><span className="eyebrow">EVENT DETAIL</span><h3>{eventLabel(selected.type)}</h3></div>
            <button className="text-button" onClick={() => setSelected(null)}>Close</button>
          </div>
          <dl className="detail-grid">
            <div><dt>Event ID</dt><dd className="mono">{selected.id}</dd></div>
            <div><dt>Source IP</dt><dd className="mono">{selected.sourceIp ?? "Unknown"}</dd></div>
            <div><dt>Route</dt><dd>{selected.route ?? "—"}</dd></div>
            <div><dt>Confirmed</dt><dd>{selected.confirmed ? "Yes" : "No"}</dd></div>
            <div><dt>Occurred</dt><dd>{formatDate(selected.createdAt)}</dd></div>
          </dl>
        </div>
      )}
    </section>
  );
}
