import { DomainRecord } from "../types/domainTypes";

export function normalizeDomain(value: string): string | null {
  if (!value) return null;
  let sanitized = value.trim().toLowerCase();
  if (!sanitized) return null;

  sanitized = sanitized.replace(/\s+/g, "");
  sanitized = sanitized.replace(/^[a-z]+:\/\//i, "");
  sanitized = sanitized.replace(/^\/\//, "");
  sanitized = sanitized.split(/[/?#]/)[0] ?? sanitized;
  sanitized = sanitized.replace(/^\.*/, "").replace(/\.*$/, "");
  if (!sanitized) return null;

  if (!sanitized.includes(".")) {
    sanitized = `${sanitized}.com`;
  }

  if (!/^[a-z0-9.-]+$/.test(sanitized)) {
    return null;
  }

  return sanitized;
}

export function deriveCore(domain: string): string {
  const trimmed = domain.startsWith("www.") ? domain.slice(4) : domain;
  const parts = trimmed.split(".");
  if (parts.length <= 1) return trimmed;
  return parts.slice(0, parts.length - 1).join(".");
}

export function parseDomainInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatDateTime(value: number | null): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "-";
  }
}

export function createId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

export function sortRecords(records: DomainRecord[], field: "domain" | "core" | "createdAt", direction: "asc" | "desc"): DomainRecord[] {
  const sorted = [...records].sort((a, b) => {
    let result = 0;
    if (field === "createdAt") {
      result = a.createdAt - b.createdAt;
    } else {
      result = a[field].localeCompare(b[field]);
    }
    return direction === "asc" ? result : -result;
  });
  return sorted;
}
