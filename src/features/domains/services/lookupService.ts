import { DomainRecord, RdapStatus } from "../types/domainTypes";

export async function runRdapLookup(domain: string): Promise<RdapStatus> {
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

export async function runDnsLookup(record: DomainRecord): Promise<DomainRecord> {
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

export async function runRdapOnly(record: DomainRecord): Promise<DomainRecord> {
  const rdapStatus = await runRdapLookup(record.domain);
  const checkedAt = Date.now();
  return { ...record, rdapStatus, checkedAt, status: record.status };
}
