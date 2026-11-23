import assert from 'node:assert/strict';
import { budgetCredits, meterColor } from '../../lib/labels';

// Usage and budget bars: accent below 80%, amber from 80%, red at 100%.
assert.equal(meterColor(79), 'bg-[var(--accent)]');
assert.equal(meterColor(80), 'bg-amber-500');
assert.equal(meterColor(99), 'bg-amber-500');
assert.equal(meterColor(100), 'bg-[var(--bad-fg)]');

// Budget form: only an empty field removes it; NaN/Infinity/negative are rejected, not sent as null.
assert.equal(budgetCredits(''), null);
assert.equal(budgetCredits('0'), 0);
assert.equal(budgetCredits('250'), 250);
for (const bad of ['abc', '1e309', '-1', 'Infinity', '1e300']) assert.equal(budgetCredits(bad), undefined, bad);
