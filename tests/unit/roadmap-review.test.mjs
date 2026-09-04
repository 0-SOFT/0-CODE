import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEW_EVERY, reviewStatus, reviewDirective,
} from '../../core/roadmap-review.mjs';

// v1.16.0. Measured across the whole project: versions ever cancelled, dropped or reordered in
// docs/ROADMAP.md — ZERO, across twenty-five-plus releases. Either the plan was perfect twenty-five
// times running, or nobody ever checked it against what had been built.
//
// The threshold is not a technical detail, so it was chosen in the open and the reasoning is on
// disk: docs/decisions/1.16.0_review-threshold.md. Ten turns is three to four finished versions at
// the measured rate of 2–3 turns per version — often enough that knowledge has accumulated, rarely
// enough that a review never lands inside unfinished work.

test('a project that has never reviewed its plan is overdue by however far it has come', () => {
  const s = reviewStatus({ iteration: 12 });
  assert.equal(s.since, 12, 'never reviewed means the whole distance counts');
  assert.equal(s.due, true);
  assert.equal(s.every, DEFAULT_REVIEW_EVERY);
});

test('a review just done resets the distance', () => {
  const s = reviewStatus({ iteration: 12, roadmap_reviewed_at_iteration: 12 });
  assert.equal(s.since, 0);
  assert.equal(s.due, false);
});

test('the threshold is crossed at the threshold, not near it', () => {
  const at9 = reviewStatus({ iteration: 9, roadmap_reviewed_at_iteration: 0 });
  const at10 = reviewStatus({ iteration: 10, roadmap_reviewed_at_iteration: 0 });
  assert.equal(at9.due, false);
  assert.equal(at10.due, true);
});

test('a project may set its own threshold', () => {
  const s = reviewStatus({ iteration: 4, roadmap_reviewed_at_iteration: 0, roadmap_review_every: 3 });
  assert.equal(s.every, 3);
  assert.equal(s.due, true);
});

// A threshold of zero or a negative number means the same thing everywhere else in this framework
// since v1.9.0: nobody asked for one. Inventing a default here would put a number in front of the
// agent that nobody chose — the defect v1.9.0 was spent on.
test('switching the review off is possible, and says nothing rather than inventing a number', () => {
  for (const off of [0, -1, null]) {
    const s = reviewStatus({ iteration: 500, roadmap_reviewed_at_iteration: 0, roadmap_review_every: off });
    assert.equal(s.due, false, `roadmap_review_every=${off} must switch it off`);
    assert.equal(s.every, null);
  }
});

test('nonsense in the fields never makes the loop crash or fire at random', () => {
  for (const st of [null, undefined, {}, { iteration: 'many' }, { roadmap_reviewed_at_iteration: 'yesterday' }]) {
    const s = reviewStatus(st);
    assert.ok(typeof s.due === 'boolean' && Number.isFinite(s.since));
  }
});

// The directive REPLACES the step instruction rather than being appended to it. Appended, it would
// be one more paragraph at the end of a long text, and the agent would do the work it was already
// doing — which is precisely how a plan goes twenty-five versions without a review.
test('the directive replaces the step instruction and says what it replaced', () => {
  const original = 'Continue implementing docs/prompts/1.16.0_decisions.md, stage 3.';
  const out = reviewDirective(original, reviewStatus({ iteration: 10 }));
  assert.ok(!out.startsWith(original), 'the review must not be a postscript to business as usual');
  assert.match(out, /ROADMAP/i);
  assert.ok(out.includes(original), 'but the work it interrupts must still be stated, to return to');
});

test('the directive names what a finished review has to record', () => {
  const out = reviewDirective('do the thing', reviewStatus({ iteration: 30 }));
  assert.match(out, /roadmap_reviewed_at_iteration/);
  assert.match(out, /roadmap_review_note/);
  // A review that always concludes "all fine" is worth nothing, so the directive has to ask for the
  // one thing that makes an unchanged plan a result rather than an omission.
  assert.match(out, /why|reason/i);
});
