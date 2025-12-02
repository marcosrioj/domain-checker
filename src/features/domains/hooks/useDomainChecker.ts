import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearAllRecords, getAllRecords, putRecords } from "../services/storage";
import { runDnsLookup, runRdapOnly } from "../services/lookupService";
import { createId, deriveCore, normalizeDomain, parseDomainInput } from "../utils/domainUtils";
import { DomainRecord, DomainStatus, RdapStatus } from "../types/domainTypes";

const BATCH_SIZE = 50;
const rdapFinalStatuses = new Set<RdapStatus>(["available", "taken"]);

function recomputeStats(snapshot: DomainRecord[]) {
  let queueCount = 0;
  let totalAvailable = 0;
  let totalTaken = 0;
  let totalChecked = 0;
  let takenOverall = 0;

  snapshot.forEach((record) => {
    if (record.status === "queued" || record.status === "checking") queueCount += 1;
    if (record.status === "available") totalAvailable += 1;
    if (record.status === "taken") totalTaken += 1;
    if (record.status !== "queued" && record.status !== "checking") totalChecked += 1;
    if (record.status === "taken" || record.rdapStatus === "taken") takenOverall += 1;
  });

  return {
    total: snapshot.length,
    queueCount,
    totalAvailable,
    totalTaken,
    totalChecked,
    takenOverall,
  };
}

function isRdapCandidate(record: DomainRecord) {
  return record.status === "available" && !rdapFinalStatuses.has(record.rdapStatus);
}

function addToQueue(queueRef: React.MutableRefObject<string[]>, setRef: React.MutableRefObject<Set<string>>, id: string) {
  if (setRef.current.has(id)) return;
  setRef.current.add(id);
  queueRef.current.push(id);
}

function removeFromQueue(setRef: React.MutableRefObject<Set<string>>, id: string) {
  setRef.current.delete(id);
}

export function useDomainChecker() {
  const [running, setRunning] = useState<{ dns: boolean; rdap: boolean }>({ dns: false, rdap: false });
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [recordsVersion, setRecordsVersion] = useState(0);
  const [stats, setStats] = useState({
    total: 0,
    queueCount: 0,
    totalAvailable: 0,
    totalTaken: 0,
    totalChecked: 0,
    takenOverall: 0,
  });

  const recordsRef = useRef<DomainRecord[]>([]);
  const indexRef = useRef<Map<string, number>>(new Map());
  const statsRef = useRef(stats);
  const renderTimeoutRef = useRef<number | null>(null);
  const stopRequestedRef = useRef<{ dns: boolean; rdap: boolean }>({ dns: false, rdap: false });
  const inFlightRef = useRef<{ dns: Set<string>; rdap: Set<string> }>({
    dns: new Set<string>(),
    rdap: new Set<string>(),
  });
  const dnsQueueRef = useRef<string[]>([]);
  const rdapQueueRef = useRef<string[]>([]);
  const dnsQueueSetRef = useRef<Set<string>>(new Set());
  const rdapQueueSetRef = useRef<Set<string>>(new Set());

  const syncRender = useCallback(() => {
    if (renderTimeoutRef.current) return;
    renderTimeoutRef.current = window.setTimeout(() => {
      renderTimeoutRef.current = null;
      setRecordsVersion((prev) => prev + 1);
      setStats({ ...statsRef.current });
    }, 50);
  }, []);

  useEffect(() => {
    getAllRecords()
      .then((items) => {
        recordsRef.current = items;
        indexRef.current = new Map(items.map((item, idx) => [item.id, idx]));
        const nextStats = recomputeStats(items);
        items.forEach((item) => {
          if (item.status === "queued") addToQueue(dnsQueueRef, dnsQueueSetRef, item.id);
          if (isRdapCandidate(item)) addToQueue(rdapQueueRef, rdapQueueSetRef, item.id);
        });
        statsRef.current = nextStats;
        setStats(nextStats);
        setRecordsVersion((prev) => prev + 1);
      })
      .catch(() => setStatusMessage("Failed to load stored domains"));
  }, []);

  const adjustStats = useCallback((prev: DomainRecord | undefined, next: DomainRecord) => {
    const applyDelta = (record: DomainRecord, delta: 1 | -1) => {
      if (record.status === "queued" || record.status === "checking") statsRef.current.queueCount += delta;
      if (record.status === "available") statsRef.current.totalAvailable += delta;
      if (record.status === "taken") statsRef.current.totalTaken += delta;
      if (record.status !== "queued" && record.status !== "checking") statsRef.current.totalChecked += delta;
      if (record.status === "taken" || record.rdapStatus === "taken") statsRef.current.takenOverall += delta;
    };
    if (prev) applyDelta(prev, -1);
    applyDelta(next, 1);
  }, []);

  const upsertRecords = useCallback(
    async (updates: DomainRecord[]) => {
      if (!updates.length) return;

      updates.forEach((item) => {
        const existingIndex = indexRef.current.get(item.id);
        const prev = existingIndex !== undefined ? recordsRef.current[existingIndex] : undefined;

        if (existingIndex !== undefined) {
          recordsRef.current[existingIndex] = item;
        } else {
          indexRef.current.set(item.id, recordsRef.current.length);
          recordsRef.current.push(item);
          statsRef.current.total += 1;
        }

        adjustStats(prev, item);
        if (prev?.status === "queued" && item.status !== "queued") removeFromQueue(dnsQueueSetRef, item.id);
        if (item.status === "queued") addToQueue(dnsQueueRef, dnsQueueSetRef, item.id);

        const prevRdapCandidate = prev ? isRdapCandidate(prev) : false;
        const nextRdapCandidate = isRdapCandidate(item);
        if (prevRdapCandidate && !nextRdapCandidate) removeFromQueue(rdapQueueSetRef, item.id);
        if (nextRdapCandidate) addToQueue(rdapQueueRef, rdapQueueSetRef, item.id);
      });

      syncRender();
      await putRecords(updates);
    },
    [adjustStats, syncRender],
  );

  const enqueueDomains = useCallback(
    async (rawInput: string) => {
      const entries = parseDomainInput(rawInput);
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
    },
    [upsertRecords],
  );

  const startChecker = useCallback(
    async (checker: "dns" | "rdap") => {
      if (running[checker]) return;
      inFlightRef.current[checker].clear();
      stopRequestedRef.current[checker] = false;
      setRunning((prev) => ({ ...prev, [checker]: true }));
      setStatusMessage(checker === "dns" ? "DNS checker running (Google DNS)" : "Domain checker running (RDAP)");
      let finalStatus = checker === "dns" ? "DNS checker idle" : "Domain checker idle";
      let processedCount = 0;

      const popCandidate = (): DomainRecord | null => {
        const queueRef = checker === "dns" ? dnsQueueRef.current : rdapQueueRef.current;
        const setRef = checker === "dns" ? dnsQueueSetRef.current : rdapQueueSetRef.current;

        while (queueRef.length) {
          const id = queueRef.shift() as string;
          if (!setRef.has(id)) continue;
          if (inFlightRef.current[checker].has(id)) continue;
          const idx = indexRef.current.get(id);
          if (idx === undefined) {
            setRef.delete(id);
            continue;
          }
          setRef.delete(id);
          return recordsRef.current[idx];
        }
        return null;
      };

      const processOne = async () => {
        if (stopRequestedRef.current[checker]) return;
        const candidate = popCandidate();
        if (!candidate) return;

        inFlightRef.current[checker].add(candidate.id);

        if (checker === "dns") {
          await upsertRecords([{ ...candidate, status: "checking" }]);
          const processed = await runDnsLookup({ ...candidate, status: "checking" });
          await upsertRecords([processed]);
          processedCount += 1;
          setStatusMessage(`DNS checked ${processedCount} domain${processedCount === 1 ? "" : "s"}`);
        } else {
          const processed = await runRdapOnly(candidate);
          await upsertRecords([processed]);
          processedCount += 1;
          setStatusMessage(`RDAP checked ${processedCount} domain${processedCount === 1 ? "" : "s"}`);
        }

        inFlightRef.current[checker].delete(candidate.id);
      };

      const workers = Array.from({ length: BATCH_SIZE }).map(async () => {
        while (!stopRequestedRef.current[checker]) {
          const before = processedCount;
          await processOne();
          if (stopRequestedRef.current[checker]) break;
          const progressMade = processedCount > before;
          const hasMore = !!(checker === "dns" ? dnsQueueSetRef.current.size : rdapQueueSetRef.current.size);
          if (!progressMade && !hasMore) break;
        }
      });

      await Promise.all(workers);

      const wasStopped = stopRequestedRef.current[checker];
      stopRequestedRef.current[checker] = false;
      setRunning((prev) => ({ ...prev, [checker]: false }));
      if (wasStopped) {
        finalStatus = "Stop requested. Finishing current batch.";
      } else if (processedCount === 0) {
        finalStatus = checker === "dns" ? "No queued domains to check via DNS" : "No available domains pending RDAP check";
      }
      setStatusMessage(finalStatus);
    },
    [running, upsertRecords],
  );

  const stopChecker = useCallback(
    (checker: "dns" | "rdap") => {
      if (!running[checker]) return;
      stopRequestedRef.current[checker] = true;
      setStatusMessage(
        checker === "dns" ? "DNS stop requested. Finishing current in-flight lookups." : "RDAP stop requested. Finishing current in-flight lookups.",
      );
    },
    [running],
  );

  const handleClear = useCallback(async () => {
    stopRequestedRef.current = { dns: true, rdap: true };
    setRunning({ dns: false, rdap: false });
    recordsRef.current = [];
    indexRef.current.clear();
    statsRef.current = { total: 0, queueCount: 0, totalAvailable: 0, totalTaken: 0, totalChecked: 0, takenOverall: 0 };
    setStats(statsRef.current);
    setRecordsVersion((prev) => prev + 1);
    await clearAllRecords();
    setStatusMessage("History cleared");
  }, []);

  return {
    records: recordsRef.current,
    recordsVersion,
    running,
    statusMessage,
    queueCount: stats.queueCount,
    totalAvailable: stats.totalAvailable,
    totalTaken: stats.totalTaken,
    totalChecked: stats.totalChecked,
    takenOverall: stats.takenOverall,
    totalRecords: stats.total,
    enqueueDomains,
    handleStartDns: () => startChecker("dns"),
    handleStartRdap: () => startChecker("rdap"),
    handleStopDns: () => stopChecker("dns"),
    handleStopRdap: () => stopChecker("rdap"),
    handleClear,
  };
}
