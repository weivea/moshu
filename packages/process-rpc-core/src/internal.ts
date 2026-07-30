/**
 * Adapter-facing internals shared with the Node/Bun `@moshu/process-rpc` transport package. These
 * helpers are not part of the stable public API and must not be imported by product code.
 */
export { invokeRpcCallback, reportRpcCallbackError } from "./callback-errors";
export { hasSafeRpcJsonStructure } from "./json-structure";
export type { RpcPeerInternalOptions } from "./peer";
export { hasUnsupportedRpcSchemaVersion } from "./protocol";
export { truncateWebSocketCloseReason } from "./websocket-utils";
