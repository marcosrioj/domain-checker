import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearAllRecords, getAllRecords, putRecords } from "../services/storage";
import { runDnsLookup, runRdapOnly } from "../services/lookupService";
import { createId, deriveCore, normalizeDomain, parseDomainInput } from "../utils/domainUtils";
import { DomainRecord, DomainStatus, RdapStatus } from "../types/domainTypes";

const BATCH_SIZE = 50;
const rdapFinalStatuses = new Set<RdapStatus>(["available", "taken"]);

export function useDomainChecker() {
  const [records, setRecords] = useState<DomainRecord[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [rdapOnly, setRdapOnly] = useState(false);

  const recordsRef = useRef<DomainRecord[]>([]);
  const stopRequestedRef = useRef(false);
  const rdapOnlyRef = useRef(false);

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

  const handleStart = useCallback(async () => {
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

      const batch = candidates.slice(0, BATCH_SIZE);
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
  }, [isRunning, upsertRecords]);

  const handleStop = useCallback(() => {
    stopRequestedRef.current = true;
    setStatusMessage("Stop requested. Finishing current batch.");
  }, []);

  const handleClear = useCallback(async () => {
    stopRequestedRef.current = true;
    setIsRunning(false);
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
    isRunning,
    statusMessage,
    rdapOnly,
    setRdapOnly,
    queueCount,
    totalAvailable,
    totalTaken,
    totalChecked,
    takenOverall,
    enqueueDomains,
    handleStart,
    handleStop,
    handleClear,
  };
}
