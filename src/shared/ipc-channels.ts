/** Electron transports the product protocol without restating individual operations. */
export const ipcChannels = {
  request: 'csv-viewer:request',
  event: 'csv-viewer:event',
} as const;
