export const IMAGE_ADMISSION_VERSION = 1
export const IMAGE_BRIDGE_VERSION = 1
export const RUNTIME_VERSION = '0.2.1-rc.3'
export const SOURCE_COMMIT = '1f81c047fc48fa190a683e469daa699857e9afe8'
export const IMAGE_FORMATS = Object.freeze(['image/png', 'image/jpeg', 'image/webp'])
export const IMAGE_LIMITS = Object.freeze({
  maxImages: 4, maxImageBytes: 4 * 1024 * 1024, maxTotalImageBytes: 8 * 1024 * 1024,
  maxEdge: 8192, maxImagePixels: 16_000_000, maxTotalImagePixels: 32_000_000,
  maxRequestBytes: 12 * 1024 * 1024, maxFrameBytes: 16 * 1024 * 1024, maxPendingBytes: 32 * 1024 * 1024,
})
export const IMAGE_RESOURCE_CONTRACT = Object.freeze({
  version: IMAGE_ADMISSION_VERSION, bridgeVersion: IMAGE_BRIDGE_VERSION,
  runtimeVersion: RUNTIME_VERSION, sourceCommit: SOURCE_COMMIT,
  formats: IMAGE_FORMATS, limits: IMAGE_LIMITS,
})
