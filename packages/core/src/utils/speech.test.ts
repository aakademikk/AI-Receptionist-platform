import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanForSpeech, limitForSpeech } from './speech.ts';

describe('cleanForSpeech', () => {
  it('leaves ordinary prose alone', () => {
    const body = 'Yes, we can get someone out to you. Which day suits you best?';
    assert.equal(cleanForSpeech(body), body);
  });

  it('strips bold and italic markers without losing the words', () => {
    assert.equal(
      cleanForSpeech('It is **£120** for a *standard* callout.'),
      'It is £120 for a standard callout.',
    );
  });

  it('keeps a link label and drops the URL', () => {
    assert.equal(
      cleanForSpeech('You can see it on [our price list](https://example.com/prices).'),
      'You can see it on our price list.',
    );
  });

  it('removes a bare URL and tidies the space it leaves', () => {
    // Left alone this reads as "send it to ." — the space before the full stop is the
    // sort of detail that is invisible in a diff and obvious in a voice.
    assert.equal(cleanForSpeech('I will send it to https://example.com/quote now.'), 'I will send it to now.');
  });

  it('flattens headings, bullets and blockquotes into sentences', () => {
    const body = ['## Services', '', '- Gutter clearing', '- Roof repair', '', '> Call us'].join('\n');
    assert.equal(cleanForSpeech(body), 'Services Gutter clearing Roof repair Call us');
  });

  it('turns line breaks into spaces, because speech has none', () => {
    assert.equal(cleanForSpeech('One.\nTwo.'), 'One. Two.');
  });

  it('removes emoji rather than letting them be read aloud by name', () => {
    assert.equal(cleanForSpeech('Thanks! 👍 We will be in touch.'), 'Thanks! We will be in touch.');
  });

  it('strips angle brackets so nothing can reach the synthesiser as markup', () => {
    assert.equal(cleanForSpeech('say <break time="3s"/> now'), 'say break time="3s"/ now');
  });

  it('is idempotent, because it runs at both the domain and the transport boundary', () => {
    const once = cleanForSpeech('**Yes** — [see here](https://example.com) 👍');
    assert.equal(cleanForSpeech(once), once);
  });
});

describe('limitForSpeech', () => {
  it('leaves a turn within the limit untouched', () => {
    const body = 'Yes, we cover that postcode. What day suits you?';
    const result = limitForSpeech(body, 400);
    assert.equal(result.wasTrimmed, false);
    assert.equal(result.body, body);
  });

  it('cuts at the last sentence end when it keeps most of the turn', () => {
    const body = 'We can do Thursday morning. The callout is eighty pounds. Would you like me to book it in?';
    const result = limitForSpeech(body, 60);
    assert.equal(result.wasTrimmed, true);
    assert.equal(result.body, 'We can do Thursday morning. The callout is eighty pounds.');
  });

  it('falls back to a word boundary when there is no usable sentence end', () => {
    const result = limitForSpeech('one two three four five six seven eight', 20);
    assert.equal(result.body, 'one two three four');
    assert.equal(result.wasTrimmed, true);
  });

  it('never marks the cut, because a caller can simply ask again', () => {
    const result = limitForSpeech('a'.repeat(500), 100);
    assert.equal(result.body.includes('...'), false);
    assert.equal(result.body.includes('…'), false);
  });

  it('does not split a character in half when the run has no spaces', () => {
    // Astral-plane characters are two code units each, so a naive slice cuts one in two
    // and leaves a lone surrogate at the end of the spoken sentence. Matched with a
    // regex rather than `String.prototype.isWellFormed`, which needs an ES2024 lib this
    // package does not target.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    const result = limitForSpeech('𝔸'.repeat(500), 10);
    assert.equal([...result.body].length, 10);
    assert.equal(loneSurrogate.test(result.body), false);
  });
});
