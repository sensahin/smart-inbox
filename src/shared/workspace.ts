export type WorkspaceSettings = {
  name: string;
  logo: string;
  documentation_url: string;
  product_name: string;
  subject_identifiers: string[];
  timezone: string;
};

export const DEFAULT_WORKSPACE: WorkspaceSettings = {
  name: "Smart Inbox",
  logo: "",
  documentation_url: "",
  product_name: "",
  subject_identifiers: [],
  timezone: "UTC",
};

/** Only public HTTPS hostnames; credentials, IPs and local service names are refused. */
export function publicHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.hash &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname) &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|arpa|home|lan|onion)$/.test(
        u.hostname,
      )
    );
  } catch {
    return false;
  }
}

export function documentationLink(url: string, index: string): boolean {
  if (!index || !publicHttpsUrl(url)) return false;
  try {
    return new URL(url).origin === new URL(index).origin;
  } catch {
    return false;
  }
}
