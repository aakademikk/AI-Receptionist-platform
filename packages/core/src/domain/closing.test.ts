import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANYTHING_ELSE_LINE,
  GOODBYE_LINE,
  PASSED_ON_GOODBYE_LINE,
  PASSED_ON_LINE,
  STILL_THERE_LINE,
  decideCallerClosing,
  decideMutedTurn,
  isCallerClosing,
  isDecliningMore,
  isWrapUpLine,
} from './closing.ts';

describe('closing lines', () => {
  it('are fixed, non-empty sentences written for speech', () => {
    for (const line of [ANYTHING_ELSE_LINE, GOODBYE_LINE, STILL_THERE_LINE]) {
      assert.ok(line.trim().length > 0);
      assert.doesNotMatch(line, /[*_#<>]/);
    }
    assert.ok(ANYTHING_ELSE_LINE.endsWith('?'));
    assert.ok(STILL_THERE_LINE.endsWith('?'));
    // The goodbye closes the call, so it must not invite an answer.
    assert.ok(!GOODBYE_LINE.endsWith('?'));
  });
});

describe('isCallerClosing', () => {
  it('matches goodbye-type utterances', () => {
    for (const heard of [
      'bye',
      'Bye.',
      'Goodbye',
      'Cheers, bye.',
      "That's all.",
      "that's everything",
      'No thanks, bye.',
      "Thanks, that's it.",
      'Okay, thank you, bye bye.',
      "That's all I needed, thank you.",
      'Lovely, thanks very much. Bye.',
      'That’s all, cheers',
    ]) {
      assert.equal(isCallerClosing(heard), true, heard);
    }
  });

  it('does not match when the utterance also carries a request or a question', () => {
    for (const heard of [
      'Bye, actually can you send me the price?',
      'bye, actually can you send me the price',
      'What time do you close, bye',
      "That's all, but what about Saturday",
      "That's it, the boiler's broken again",
      'Bye?',
    ]) {
      assert.equal(isCallerClosing(heard), false, heard);
    }
  });

  it('does not treat an acknowledgement on its own as a goodbye', () => {
    // "Thanks" after an answer is how people nod, not how they leave.
    for (const heard of ['Thanks', 'Okay, great', 'No', 'Cheers', '', '   ']) {
      assert.equal(isCallerClosing(heard), false, JSON.stringify(heard));
    }
  });
});

describe('isDecliningMore', () => {
  it('matches a no to "anything else?"', () => {
    for (const heard of [
      'No',
      'No thanks.',
      'Nope',
      "That's it",
      "That's all",
      "No, that's everything",
      "No, I'm good, thanks",
      'Bye',
      'Cheers, bye.',
    ]) {
      assert.equal(isDecliningMore(heard), true, heard);
    }
  });

  it('does not match "no, but..." or anything with a question', () => {
    for (const heard of [
      'No, but can you tell me the price',
      'No, but',
      'No?',
      'Actually yes, do you do boilers?',
      'Do you do boilers',
      'Yes',
      'Yeah, one more thing',
      '',
    ]) {
      assert.equal(isDecliningMore(heard), false, JSON.stringify(heard));
    }
  });
});

describe('decideCallerClosing', () => {
  it('asks "anything else?" when the caller first says goodbye (check 1)', () => {
    assert.equal(decideCallerClosing({ heard: "That's all, bye", anythingElseAsked: false, anythingElseJustAsked: false }), 'ask_anything_else');
    assert.equal(decideCallerClosing({ heard: 'Cheers, bye.', anythingElseAsked: false, anythingElseJustAsked: false }), 'ask_anything_else');
  });

  it('says goodbye when the caller answers "no thanks" after the ask (check 2)', () => {
    assert.equal(decideCallerClosing({ heard: 'No thanks', anythingElseAsked: true, anythingElseJustAsked: true }), 'goodbye');
    assert.equal(decideCallerClosing({ heard: 'No', anythingElseAsked: true, anythingElseJustAsked: true }), 'goodbye');
  });

  it('says goodbye, never a second ask, on a second "bye" (check 2)', () => {
    assert.equal(decideCallerClosing({ heard: 'Bye', anythingElseAsked: true, anythingElseJustAsked: true }), 'goodbye');
    assert.equal(decideCallerClosing({ heard: "That's all, bye", anythingElseAsked: true, anythingElseJustAsked: true }), 'goodbye');
  });

  it('carries on normally when the caller raises something new after the ask (check 2)', () => {
    assert.equal(
      decideCallerClosing({ heard: 'Actually, do you work weekends?', anythingElseAsked: true, anythingElseJustAsked: true }),
      'none',
    );
    assert.equal(
      decideCallerClosing({ heard: 'No, but can you send me a quote', anythingElseAsked: true, anythingElseJustAsked: true }),
      'none',
    );
  });

  it('treats a later bare "no" as an answer to her last question, not to "anything else?"', () => {
    // Asked earlier, the caller raised something new, and Amy has since asked "is it urgent?".
    for (const heard of ['No', 'No thanks', 'Nope']) {
      assert.equal(
        decideCallerClosing({ heard, anythingElseAsked: true, anythingElseJustAsked: false }),
        'none',
        heard,
      );
    }
  });

  it('says goodbye, never a second ask, on a real goodbye later in the call', () => {
    assert.equal(
      decideCallerClosing({ heard: 'Cheers, bye', anythingElseAsked: true, anythingElseJustAsked: false }),
      'goodbye',
    );
  });

  it('is an ordinary turn when nobody is closing', () => {
    assert.equal(decideCallerClosing({ heard: 'I need a boiler service', anythingElseAsked: false, anythingElseJustAsked: false }), 'none');
    // A bare "no" before anything was asked is an answer to some other question.
    assert.equal(decideCallerClosing({ heard: 'No', anythingElseAsked: false, anythingElseJustAsked: false }), 'none');
  });
});

describe('isWrapUpLine', () => {
  it('matches the assistant signing off', () => {
    for (const speak of [
      'No problem at all. Have a good evening.',
      'Have a great day!',
      'Thanks for calling, bye for now.',
      GOODBYE_LINE,
      'No worries, sorry for the confusion. Take care.',
      'Thank you for calling Atwood Plumbing.',
    ]) {
      assert.equal(isWrapUpLine(speak), true, speak);
    }
  });

  it('does not match a sign-off that ends in a question', () => {
    assert.equal(isWrapUpLine("Have a good evening, what's the address?"), false);
    assert.equal(isWrapUpLine('Thanks for calling. Is there anything else I can help you with?'), false);
  });

  it('does not match an ordinary reply', () => {
    for (const speak of [
      'We can come out on Tuesday morning.',
      'A boiler service is usually around eighty pounds.',
      "What's the postcode?",
      '',
    ]) {
      assert.equal(isWrapUpLine(speak), false, JSON.stringify(speak));
    }
  });
});

describe('decideMutedTurn', () => {
  it('thanks the caller and keeps the line open for one more answer', () => {
    assert.deepEqual(decideMutedTurn({ anythingElseJustAsked: false }), {
      speak: PASSED_ON_LINE,
      endCall: false,
      closing: 'asked_anything_else',
    });
  });

  it('says goodbye and hangs up once that answer is in, whatever it was', () => {
    assert.deepEqual(decideMutedTurn({ anythingElseJustAsked: true }), {
      speak: PASSED_ON_GOODBYE_LINE,
      endCall: true,
      closing: 'none',
    });
  });

  it('never tells a caller who has been handed over that nobody can help', () => {
    for (const line of [PASSED_ON_LINE, PASSED_ON_GOODBYE_LINE]) {
      assert.doesNotMatch(line, /can't help|cannot help|unable to help/i);
      assert.doesNotMatch(line, /[*_#<>]/);
    }
    assert.ok(PASSED_ON_LINE.endsWith('?'));
    assert.ok(!PASSED_ON_GOODBYE_LINE.endsWith('?'));
  });
});
