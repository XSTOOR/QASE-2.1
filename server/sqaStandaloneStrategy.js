// Pinned per run: changing an operator flag cannot reinterpret saved evidence.
export const SQA_STANDALONE_STRATEGY = 'sqa-single-reasoner-v1';
export const standaloneSqa = session => session.mode === 'sqa' && session.sqa?.execution?.strategy === SQA_STANDALONE_STRATEGY;
