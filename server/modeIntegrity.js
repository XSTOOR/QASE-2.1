import {createHash} from 'node:crypto';

// Normalize JSON values first (undefined omission, dates and non-finite numbers)
// exactly as persistence does, then sort object keys. Array order is evidence.
function ordered(value){
 if(Array.isArray(value))return value.map(ordered);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));
 return value;
}
export const legacyModeHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const canonicalModeHash=value=>legacyModeHash(ordered(JSON.parse(JSON.stringify(value))));
export const modeReceiptHash=receipt=>(receipt.hashVersion===1?canonicalModeHash:legacyModeHash)(receipt.result);
