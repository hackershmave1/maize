import { useEffect, useState } from "react";
import Detections from "./pages/Detections";
import Containment from "./pages/Containment";
import Settings from "./pages/Settings";

type Page = "detections" | "containment" | "settings";

const navigation: { id: Page; label: string; caption: string }[] = [
  { id: "detections", label: "Detections", caption: "Event history" },
  { id: "containment", label: "Containment", caption: "Active blocks" },
  { id: "settings", label: "Settings", caption: "Runtime controls" },
];

function currentPage(): Page {
  const page = window.location.hash.slice(1);
  return navigation.some((entry) => entry.id === page) ? page as Page : "detections";
}

export default function App() {
  const [page, setPage] = useState<Page>(currentPage);

  useEffect(() => {
    const updatePage = () => setPage(currentPage());
    window.addEventListener("hashchange", updatePage);
    if (!window.location.hash) window.location.hash = "detections";
    return () => window.removeEventListener("hashchange", updatePage);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#detections" aria-label="MAIZE Control Room home">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>
            <strong>MAIZE</strong>
            <small>CONTROL ROOM</small>
          </span>
        </a>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <a
              aria-current={page === item.id ? "page" : undefined}
              className={`nav-link ${page === item.id ? "is-current" : ""}`}
              href={`#${item.id}`}
              key={item.id}
            >
              <span>{item.label}</span>
              <small>{item.caption}</small>
            </a>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          <span>Protected by Cloudflare Access</span>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">SECURITY OPERATIONS</span>
            <h1>{navigation.find((item) => item.id === page)?.label}</h1>
          </div>
          <span className="access-badge"><span className="status-dot" />Private session</span>
        </header>
        <div className="content">
          {page === "detections" && <Detections />}
          {page === "containment" && <Containment />}
          {page === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}
