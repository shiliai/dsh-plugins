/**
 * Shared config-portability contract (isomorphic, no react dependency here —
 * the browser tab lives in `./client.tsx`, which plugins import separately).
 */
export * from './contracts.js'
export * from './provider.js'
export * from './server.js'
