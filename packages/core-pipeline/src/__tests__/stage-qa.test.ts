import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStageQuestions,
  formatStageAnswers,
  STAGE_QA_PROMPT_HEADER,
} from '../stages/qa.js';

describe('parseStageQuestions', () => {
  it('extracts numbered questions from a <questions> block', () => {
    const text = `<questions>
1. Should the booking flow support guest checkout, or require a logged-in user?
2. Do existing users keep their carts on plan switch?
</questions>`;
    const out = parseStageQuestions(text, 5);
    assert.equal(out.length, 2);
    assert.match(out[0], /guest checkout/);
    assert.match(out[1], /existing users/);
  });

  it('returns [] when no <questions> block is present', () => {
    assert.deepEqual(parseStageQuestions('# Requirements\n\nBuild the booking page.', 5), []);
  });

  it('returns [] when the block is malformed (open tag, no close)', () => {
    assert.deepEqual(parseStageQuestions('<questions>\n1. orphan?', 5), []);
  });

  it('returns [] for an empty <questions></questions> block', () => {
    assert.deepEqual(parseStageQuestions('<questions></questions>', 5), []);
  });

  it('caps at maxQuestions when the agent emits more', () => {
    const text = `<questions>
1. q one is long enough?
2. q two is long enough?
3. q three is long enough?
4. q four is long enough?
5. q five is long enough?
6. q six is long enough?
7. q seven is long enough?
</questions>`;
    const out = parseStageQuestions(text, 3);
    assert.equal(out.length, 3);
  });

  it('returns [] when maxQuestions is 0', () => {
    const text = '<questions>\n1. test long enough question?\n</questions>';
    assert.deepEqual(parseStageQuestions(text, 0), []);
  });
});

describe('formatStageAnswers', () => {
  it('renders Q&A pairs in an <answers> block', () => {
    const out = formatStageAnswers([
      { question: 'guest checkout?', answer: 'yes for browse, login on payment' },
      { question: 'cart on switch?', answer: 'preserve' },
    ]);
    assert.match(out, /<answers>/);
    assert.match(out, /<\/answers>/);
    assert.match(out, /1\. Q: guest checkout\?/);
    assert.match(out, /2\. Q: cart on switch\?/);
    assert.match(out, /A: preserve/);
  });
});

describe('STAGE_QA_PROMPT_HEADER', () => {
  it('includes the cap value in the prompt', () => {
    const header = STAGE_QA_PROMPT_HEADER(3);
    assert.match(header, /up to 3 questions/);
    assert.match(header, /<questions>/);
  });
});
