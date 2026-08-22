/**
 * Electron transport names. Only the main process and the preload bridge may import this: the
 * renderer reaches its host through CsvViewerRuntime, and the shared workspace is runtime-neutral.
 */
export const ipcChannels = {
  healthCheck: 'app:health-check',
  openCsv: 'csv:open',
  openRecentCsv: 'csv:open-recent',
  reopenCsv: 'csv:reopen',
  closeCsv: 'csv:close',
  getComparisonCandidates: 'comparison:candidates',
  openComparison: 'comparison:open',
  getComparisonState: 'comparison:get-state',
  beginComparison: 'comparison:begin',
  cancelComparison: 'comparison:cancel',
  getComparisonWindow: 'comparison:get-window',
  swapComparison: 'comparison:swap',
  closeComparison: 'comparison:close',
  comparisonStateChanged: 'comparison:state-changed',
  getRecentCsvSources: 'csv:get-recent-sources',
  getCsvRows: 'csv:get-rows',
  getCsvColumnValueCounts: 'csv:get-column-value-counts',
  editCsvCell: 'csv:edit-cell',
  deleteCsvRows: 'csv:delete-rows',
  insertCsvRow: 'csv:insert-row',
  getCsvEditState: 'csv:get-edit-state',
  exportCsv: 'csv:export',
  undoCsvEdit: 'csv:undo-edit',
  redoCsvEdit: 'csv:redo-edit',
  intent: 'app:intent',
} as const;
