import React, { useEffect, useMemo, useRef, useState } from "react";
import { clearAllRecords, getAllRecords, putRecords } from "./storage";
import { createId, deriveCore, formatDateTime, normalizeDomain, parseDomainInput, sortRecords } from "./utils";
import { DomainRecord, DomainStatus, RdapStatus, SortDirection, SortField } from "./types";

const PAGE_SIZE = 20;
const STATUS_OPTIONS: Array<DomainStatus | "all"> = ["all", "queued", "checking", "available", "taken", "unknown"];
const RDAP_OPTIONS: Array<RdapStatus | "all"> = ["all", "available", "taken", "unknown", "not_checked"];
const rdapFinalStatuses = new Set<RdapStatus>(["available", "taken"]);

async function runRdapLookup(domain: string): Promise<RdapStatus> {
  try {
    const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
    if (response.status === 404) {
      return "available";
    }
    if (response.ok) {
      return "taken";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function runDnsLookup(record: DomainRecord): Promise<DomainRecord> {
  const next: DomainRecord = { ...record, checkedAt: Date.now() };
  try {
    const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(record.domain)}&type=NS`);
    if (!response.ok) {
      next.status = "unknown";
      next.rdapStatus = "not_checked";
      return next;
    }
    const data = await response.json();
    const code: number | undefined = data?.Status;

    if (code === 3) {
      next.status = "available";
      next.rdapStatus = await runRdapLookup(record.domain);
      return next;
    }

    if (code === 2 || code === 5 || typeof code !== "number") {
      next.status = "unknown";
      next.rdapStatus = "not_checked";
      return next;
    }

    next.status = "taken";
    next.rdapStatus = "not_checked";
    return next;
  } catch {
    next.status = "unknown";
    next.rdapStatus = "not_checked";
    return next;
  }
}

async function runRdapOnly(record: DomainRecord): Promise<DomainRecord> {
  const rdapStatus = await runRdapLookup(record.domain);
  const checkedAt = Date.now();
  return { ...record, rdapStatus, checkedAt, status: record.status };
}

function StatusPill({ label, tone }: { label: string; tone: "green" | "yellow" | "blue" | "gray" | "red" }) {
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

function chipForStatus(status: DomainStatus) {
  switch (status) {
    case "available":
      return <StatusPill label="Available" tone="green" />;
    case "queued":
      return <StatusPill label="Queued" tone="blue" />;
    case "checking":
      return <StatusPill label="Checking" tone="yellow" />;
    case "taken":
      return <StatusPill label="Taken" tone="red" />;
    default:
      return <StatusPill label="Unknown" tone="gray" />;
  }
}

function chipForRdap(status: RdapStatus) {
  switch (status) {
    case "available":
      return <StatusPill label="RDAP: Available" tone="green" />;
    case "taken":
      return <StatusPill label="RDAP: Taken" tone="red" />;
    case "unknown":
      return <StatusPill label="RDAP: Unknown" tone="gray" />;
    default:
      return <StatusPill label="RDAP: Not checked" tone="blue" />;
  }
}

export default function App() {
  const [records, setRecords] = useState<DomainRecord[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [statusFilter, setStatusFilter] = useState<DomainStatus | "all">("all");
  const [rdapFilter, setRdapFilter] = useState<RdapStatus | "all">("all");
  const [rdapOnly, setRdapOnly] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [page, setPage] = useState(1);

  const recordsRef = useRef<DomainRecord[]>([]);
  const stopRequestedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rdapOnlyRef = useRef(false);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(() => {
    rdapOnlyRef.current = rdapOnly;
  }, [rdapOnly]);

  useEffect(() => {
    getAllRecords()
      .then((items) => {
        setRecords(items);
        recordsRef.current = items;
      })
      .catch(() => setStatusMessage("Failed to load stored domains"));
  }, []);

  const upsertRecords = async (updates: DomainRecord[]) => {
    if (!updates.length) return;
    setRecords((prev) => {
      const map = new Map(prev.map((item) => [item.id, item]));
      updates.forEach((item) => {
        map.set(item.id, item);
      });
      const merged = Array.from(map.values());
      recordsRef.current = merged;
      return merged;
    });
    await putRecords(updates);
  };

  const enqueueDomains = async (entries: string[]) => {
    const existing = new Set(recordsRef.current.map((item) => item.domain));
    const toAdd: DomainRecord[] = [];
    entries.forEach((entry) => {
      const normalized = normalizeDomain(entry);
      if (!normalized) return;
      if (existing.has(normalized)) return;
      existing.add(normalized);
      toAdd.push({
        id: createId(),
        domain: normalized,
        core: deriveCore(normalized),
        status: "queued",
        rdapStatus: "not_checked",
        createdAt: Date.now(),
        checkedAt: null,
        source: "import",
      });
    });

    if (!toAdd.length) {
      setStatusMessage("No new domains added");
      return;
    }

    await upsertRecords(toAdd);
    setStatusMessage(`Added ${toAdd.length} domain${toAdd.length === 1 ? "" : "s"} to the queue`);
  };

  const handleAddFromText = async () => {
    const parsed = parseDomainInput(inputValue);
    await enqueueDomains(parsed);
    setInputValue("");
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await enqueueDomains(parseDomainInput(text));
    event.target.value = "";
  };

  const handleStart = async () => {
    if (isRunning) return;
    stopRequestedRef.current = false;
    setIsRunning(true);
    setStatusMessage(rdapOnlyRef.current ? "RDAP-only mode running" : "Checker started");

    while (!stopRequestedRef.current) {
      const snapshot = recordsRef.current;
      const candidates = rdapOnlyRef.current
        ? snapshot.filter((item) => item.status === "available" && !rdapFinalStatuses.has(item.rdapStatus))
        : snapshot.filter((item) => item.status === "queued");

      if (!candidates.length) {
        setStatusMessage("Nothing left to process");
        break;
      }

      const batch = candidates.slice(0, 50);
      await upsertRecords(
        batch.map((item) => ({
          ...item,
          status: "checking",
        })),
      );

      const processed = await Promise.all(
        batch.map((record) => (rdapOnlyRef.current ? runRdapOnly(record) : runDnsLookup(record))),
      );

      await upsertRecords(processed);
      setStatusMessage(`Processed ${processed.length} domain${processed.length === 1 ? "" : "s"}`);

      if (stopRequestedRef.current) break;
    }

    stopRequestedRef.current = false;
    setIsRunning(false);
    setStatusMessage("Checker idle");
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    setStatusMessage("Stop requested. Finishing current batch.");
  };

  const handleClear = async () => {
    stopRequestedRef.current = true;
    setIsRunning(false);
    await clearAllRecords();
    setRecords([]);
    recordsRef.current = [];
    setStatusMessage("History cleared");
  };

  const filteredRecords = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return records.filter((item) => {
      const statusMatch = statusFilter === "all" || item.status === statusFilter;
      const rdapMatch = rdapFilter === "all" || item.rdapStatus === rdapFilter;
      const textMatch = !term || item.domain.includes(term) || item.core.includes(term);
      return statusMatch && rdapMatch && textMatch;
    });
  }, [records, rdapFilter, searchTerm, statusFilter]);

  const sortedRecords = useMemo(() => sortRecords(filteredRecords, sortField, sortDirection), [filteredRecords, sortDirection, sortField]);

  const totalPages = Math.max(1, Math.ceil(sortedRecords.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRecords = sortedRecords.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const queueCount = useMemo(
    () => records.filter((item) => item.status === "queued" || item.status === "checking").length,
    [records],
  );
  const totalAvailable = useMemo(() => records.filter((item) => item.status === "available").length, [records]);
  const totalTaken = useMemo(() => records.filter((item) => item.status === "taken").length, [records]);
  const totalChecked = useMemo(
    () => records.filter((item) => item.status !== "queued" && item.status !== "checking").length,
    [records],
  );
  const takenOverall = useMemo(
    () => records.filter((item) => item.status === "taken" || item.rdapStatus === "taken").length,
    [records],
  );

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
    setPage(1);
  };

  const showingStart = (safePage - 1) * PAGE_SIZE + 1;
  const showingEnd = Math.min(safePage * PAGE_SIZE, sortedRecords.length);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Domain Checker</p>
          <h1>Queue, persist, and verify domains</h1>
          <p className="muted">Lowercase + normalize inputs, store in IndexedDB, then check DNS with optional RDAP follow-up.</p>
        </div>
        <div className="header-stats">
          <div className={`runner ${isRunning ? "runner-on" : "runner-off"}`}>{isRunning ? "Running" : "Idle"}</div>
          <div className="metric">
            <span className="metric-label">Queue</span>
            <span className="metric-value">{queueCount}</span>
          </div>
          <div className="metric">
            <span className="metric-label">Total</span>
            <span className="metric-value">{records.length}</span>
          </div>
          <div className="metric">
            <span className="metric-label">RDAP only</span>
            <span className="metric-value">{rdapOnly ? "On" : "Off"}</span>
          </div>
        </div>
      </header>

      <section className="panel-grid">
        <div className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Input</p>
              <h2>Add domains</h2>
            </div>
            <div className="chip">Queued: {queueCount}</div>
          </div>
          <textarea
            className="input-area"
            placeholder="domain.com or list separated by commas/newlines"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            rows={6}
          />
          <div className="panel-actions">
            <button className="button primary" onClick={() => void handleAddFromText()} disabled={!inputValue.trim()}>
              Add to queue
            </button>
            <label className="button ghost file-label">
              Upload .txt
              <input ref={fileInputRef} className="file-input" type="file" accept=".txt" onChange={handleFileChange} />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rdapOnly}
                onChange={(event) => {
                  setRdapOnly(event.target.checked);
                  setStatusMessage(event.target.checked ? "RDAP-only mode enabled" : "RDAP-only mode disabled");
                }}
              />
              <span>RDAP only (skip DNS; revisit available domains)</span>
            </label>
          </div>
        </div>

        <div className="panel status-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Controls</p>
              <h2>Checker</h2>
            </div>
          </div>
          <div className="status-grid">
            <div>
              <p className="muted">Totals (all time)</p>
              <p className="stat-line">
                Total: <strong>{records.length}</strong> · Available: <strong>{totalAvailable}</strong> · Taken: <strong>{totalTaken}</strong>
              </p>
            </div>
            <div>
              <p className="muted">Checked</p>
              <p className="stat-line">
                Completed: <strong>{totalChecked}</strong> · Registered/Taken overall: <strong>{takenOverall}</strong>
              </p>
            </div>
            <div>
              <p className="muted">Queue size</p>
              <p className="stat-line">
                Queued + checking: <strong>{queueCount}</strong>
              </p>
            </div>
            <div>
              <p className="muted">Last status</p>
              <p className="stat-line">{statusMessage}</p>
            </div>
          </div>
          <div className="panel-actions">
            <button className="button primary" onClick={() => void handleStart()} disabled={isRunning}>
              Start checker
            </button>
            <button className="button warning" onClick={handleStop} disabled={!isRunning}>
              Stop checker
            </button>
            <button className="button ghost" onClick={() => void handleClear()}>
              Clear history
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head table-head">
          <div>
            <p className="eyebrow">Results</p>
            <h2>Queue + history</h2>
          </div>
          <div className="filters">
            <input
              className="input"
              placeholder="Search domain/core"
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value);
                setPage(1);
              }}
            />
            <select
              className="input"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as DomainStatus | "all");
                setPage(1);
              }}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  Status: {option}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={rdapFilter}
              onChange={(event) => {
                setRdapFilter(event.target.value as RdapStatus | "all");
                setPage(1);
              }}
            >
              {RDAP_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  RDAP: {option}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => handleSort("domain")}>
                  Domain {sortField === "domain" && <span className="sort-indicator">{sortDirection === "asc" ? "▲" : "▼"}</span>}
                </th>
                <th className="sortable" onClick={() => handleSort("core")}>
                  Core {sortField === "core" && <span className="sort-indicator">{sortDirection === "asc" ? "▲" : "▼"}</span>}
                </th>
                <th>Status</th>
                <th>RDAP</th>
                <th>Source</th>
                <th className="sortable" onClick={() => handleSort("createdAt")}>
                  Created {sortField === "createdAt" && <span className="sort-indicator">{sortDirection === "asc" ? "▲" : "▼"}</span>}
                </th>
                <th>Checked</th>
              </tr>
            </thead>
            <tbody>
              {pagedRecords.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted center">
                    No domains match the current filters.
                  </td>
                </tr>
              ) : (
                pagedRecords.map((item) => (
                  <tr key={item.id}>
                    <td>{item.domain}</td>
                    <td>{item.core}</td>
                    <td>{chipForStatus(item.status)}</td>
                    <td>{chipForRdap(item.rdapStatus)}</td>
                    <td className="muted">{item.source}</td>
                    <td>{formatDateTime(item.createdAt)}</td>
                    <td>{formatDateTime(item.checkedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <div className="muted">
            Showing {sortedRecords.length ? `${showingStart}-${showingEnd}` : "0"} of {sortedRecords.length} · Sorted by {sortField} ({sortDirection})
          </div>
          <div className="pager">
            <button className="button ghost" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={safePage === 1}>
              Prev
            </button>
            <span className="muted">
              Page {safePage} / {totalPages}
            </span>
            <button
              className="button ghost"
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={safePage === totalPages || totalPages === 0}
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
