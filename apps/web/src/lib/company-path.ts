type CompanyAddress = {
  id: string;
  stockCode?: string | null;
  ticker?: string | null;
  market?: string;
  isListed?: boolean;
  canonicalPath?: string;
};

/** Display addresses use public symbols; database operations continue using UUIDs. */
export function companyPath(company: CompanyAddress) {
  if (
    company.canonicalPath &&
    /^\/companies\/(?:[A-Z]+:)?[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u.test(company.canonicalPath)
  )
    return company.canonicalPath;
  return `/companies/${encodeURIComponent(company.id)}`;
}
