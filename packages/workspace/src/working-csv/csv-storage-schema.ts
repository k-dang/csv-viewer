export const csvDeletedField = '__csvViewerDeleted';
export const csvSourceOrderField = '__csvViewerSourceOrder';
export const csvFilteredRowCountField = '__csvViewerFilteredRowCount';
export const csvTotalRowCountField = '__csvViewerTotalRowCount';
export const csvHiddenColumnPrefix = '__csvViewerHidden_';

export function hiddenCsvColumnName(revisionId: number, takenNames: readonly string[]): string {
  return unusedCsvColumnName(`${csvHiddenColumnPrefix}${revisionId}`, takenNames);
}

/** DuckDB column names are case-insensitive, so `name` is extended until no taken name matches it in any case. */
export function unusedCsvColumnName(name: string, takenNames: readonly string[]): string {
  const taken = new Set(takenNames.map((takenName) => takenName.toLowerCase()));
  let unused = name;
  while (taken.has(unused.toLowerCase())) unused = `${unused}_`;
  return unused;
}
