import { Temporal } from '@js-temporal/polyfill';




// const mtime = Temporal.Instant.from('2025-12-29T10:30:45.123Z');
// const mtime = Temporal.PlainDateTime.from('2025-12-29T10:30:45');
const mtime = Temporal.PlainDateTime.from('2025-12-29T1030');

console.log(mtime.toString());
