import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearAllRecords, getAllRecords, putRecords } from "../services/storage";
import { runDnsLookup, runRdapOnly } from "../services/lookupService";
import { createId, deriveCore, normalizeDomain, parseDomainInput } from "../utils/domainUtils";
import { DomainRecord, DomainStatus, RdapStatus } from "../types/domainTypes";

const BATCH_SIZE = 50;
const rdapFinalStatuses = new Set<RdapStatus>(["available", "taken"]);

export function useDomainChecker() {
  const [records, setRecords] = useState<DomainRecord[]>([]);
  const [running, setRunning] = useState<{ dns: boolean; rdap: boolean }>({ dns: false, rdap: false });
  const [statusMessage, setStatusMessage] = useState("Idle");

  const recordsRef = useRef<DomainRecord[]>([]);
  const stopRequestedRef = useRef<{ dns: boolean; rdap: boolean }>({ dns: false, rdap: false });
  const inFlightRef = useRef<{ dns: Set<string>; rdap: Set<string> }>({
    dns: new Set<string>(),
    rdap: new Set<string>(),
  });

  useEffect(() => {
    getAllRecords()
      .then((items) => {
        setRecords(items);
        recordsRef.current = items;
      })
      .catch(() => setStatusMessage("Failed to load stored domains"));
  }, []);

  const upsertRecords = useCallback(async (updates: DomainRecord[]) => {
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
  }, []);

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

      const nextCandidate = () => {
        const snapshot = recordsRef.current;
        const pool =
          checker === "dns"
            ? snapshot.filter((item) => item.status === "queued")
            : snapshot.filter((item) => item.status === "available" && !rdapFinalStatuses.has(item.rdapStatus));
        return pool.find((item) => !inFlightRef.current[checker].has(item.id)) ?? null;
      };

      const processOne = async () => {
        if (stopRequestedRef.current[checker]) return;
        const candidate = nextCandidate();
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
          const hasMore = !!nextCandidate();
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
    await clearAllRecords();
    setRecords([]);
    recordsRef.current = [];
    setStatusMessage("History cleared");
  }, []);

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

  return {
    records,
    running,
    statusMessage,
    queueCount,
    totalAvailable,
    totalTaken,
    totalChecked,
    takenOverall,
    enqueueDomains,
    handleStartDns: () => startChecker("dns"),
    handleStartRdap: () => startChecker("rdap"),
    handleStopDns: () => stopChecker("dns"),
    handleStopRdap: () => stopChecker("rdap"),
    handleClear,
  };
}
