export type DomainStatus = "queued" | "checking" | "available" | "taken" | "unknown";
export type RdapStatus = "available" | "taken" | "unknown" | "not_checked";

export type DomainSource = "import";

export interface DomainRecord {
  id: string;
  domain: string;
  core: string;
  status: DomainStatus;
  rdapStatus: RdapStatus;
  createdAt: number;
  checkedAt: number | null;
  source: DomainSource;
}

export type SortField = "domain" | "core" | "createdAt";
export type SortDirection = "asc" | "desc";
