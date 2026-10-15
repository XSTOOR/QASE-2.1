/**
 * QA launcher scope builder. Pure — no DOM — so both the dashboard and the
 * unit tests can import it. The catalogue now lives in qaScopeCatalog.js so
 * the server can whitelist scope values with the same single definition.
 */

export { QA_SCOPE_OPTIONS, buildQaKickoffMessage } from './qaScopeCatalog.js';
