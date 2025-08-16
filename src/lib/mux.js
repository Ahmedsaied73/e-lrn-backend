/**
 * Stub file for Mux integration that has been removed
 * This file exists only to prevent import errors during the transition
 */

module.exports = {
  // Stub methods that return appropriate values or no-op functions
  createDirectUpload: () => ({
    url: null,
    id: null
  }),
  getStreamingUrl: () => null,
  deleteAsset: () => Promise.resolve(),
  getAssetInfo: () => Promise.resolve(null),
  createAsset: () => Promise.resolve({ playbackId: null, assetId: null }),
  updateAssetMP4Support: () => Promise.resolve(),
  getMP4Url: () => null
};