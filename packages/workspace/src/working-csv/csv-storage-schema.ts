export const csvDeletedField = '__csvViewerDeleted';
export const csvSourceOrderField = '__csvViewerSourceOrder';
export const csvHiddenColumnPrefix = '__csvViewerHidden_';

export function hiddenCsvColumnName(revisionId: number, takenNames: readonly string[]): string {
  const taken = new Set(takenNames.map((name) => name.toLowerCase()));
  let name = `${csvHiddenColumnPrefix}${revisionId}`;
  while (taken.has(name.toLowerCase())) name = `${name}_`;
  return name;
}
