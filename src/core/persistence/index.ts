export * from './errors.js';
export { RecordStore } from './store.js';
export type { CollectionDef, CommitCmd, CommitOutcome, OpenOptions, ReconcileReport, RecordProblem, Repository, Stored } from './store.js';
export { updateRecord } from './update.js';
export { migrateLegacyFiles } from './legacy.js';
export { localApfsProbe, requireLocalVolume } from './volume.js';
export type { VolumeProbe } from './volume.js';
export { diffRecord, applyPatch } from './patch.js';
export { ConsentStore, CONSENT_COLLECTION, CONSENT_RECORD_ID, type ConsentRecord } from './consent.js';
