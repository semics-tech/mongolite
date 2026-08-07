/**
 * Tests for the terminal UI primitives.
 *
 * Both halves of every prompt are exercised: the raw-mode arrow-key menu that
 * a real terminal gets, and the numbered line-based fallback used by pipes and
 * CI. `process.stdin` and `process.stdout` are swapped for objects we control,
 * so the interactive path can be driven by emitting keypresses without a TTY
 * being present.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PassThrough, Writable } from 'node:stream';
import * as readline from 'node:readline';

import {
  PromptCancelledError,
  closePrompts,
  confirm,
  displayWidth,
  error,
  heading,
  info,
  isInteractive,
  multilineText,
  pause,
  select,
  style,
  success,
  terminalWidth,
  text,
  truncate,
  warn,
  type Choice,
} from '../src/cli/ui';

/** A stream that claims to be a TTY, so the interactive paths engage. */
class FakeTTY extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

const strip = (value: string): string => value.replace(/\[[0-9;]*[A-Za-z]/g, '');

/** Let pending microtasks and one turn of the event loop settle. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let captured: string[] = [];
let realStdout: NodeJS.WriteStream;
let realStdin: NodeJS.ReadStream;
let realExit: typeof process.exit;

/** Settings the fake stdout reports; individual tests vary them. */
let stdoutColumns: number | undefined = 100;
let stdoutIsTTY = false;

const output = (): string => strip(captured.join(''));

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/**
 * A stand-in for process.stdout.
 *
 * The whole object is swapped rather than just its `write`, because the test
 * runner's reporter took its own reference to the real stdout when the run
 * started: patching `write` in place swallows the test results too. It is a
 * real Writable because `readline` attaches listeners to whatever it is given.
 */
class CapturingStdout extends Writable {
  isTTY = stdoutIsTTY;
  columns = stdoutColumns;
  rows = 24;

  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    captured.push(String(chunk));
    callback();
  }
}

const fakeStdout = (): NodeJS.WriteStream => new CapturingStdout() as unknown as NodeJS.WriteStream;

/** Run a scenario against the fake stdout, collecting everything it writes. */
async function withCapture<T>(scenario: () => Promise<T> | T): Promise<T> {
  captured = [];
  Object.defineProperty(process, 'stdout', { value: fakeStdout(), configurable: true });
  try {
    return await scenario();
  } finally {
    Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
  }
}

function useStdin(stream: PassThrough): void {
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
}

before(() => {
  realStdout = process.stdout;
  realStdin = process.stdin;
  realExit = process.exit;

  // A prompt that reaches the end of its input calls process.exit; in-process
  // that would take the test runner with it.
  process.exit = ((code?: number): never => {
    throw new ExitCalled(code);
  }) as typeof process.exit;
});

after(() => {
  process.exit = realExit;
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
});

// ---------------------------------------------------------------- pure helpers

describe('CLI text helpers', () => {
  it('measures width ignoring colour escapes', () => {
    assert.strictEqual(displayWidth('hello'), 5);
    assert.strictEqual(displayWidth('[1mhello[22m'), 5);
    assert.strictEqual(displayWidth(''), 0);
  });

  it('truncates to a visible width with an ellipsis', () => {
    assert.strictEqual(truncate('abcdef', 10), 'abcdef');
    assert.strictEqual(truncate('abcdef', 6), 'abcdef');
    assert.strictEqual(truncate('abcdef', 4), 'abc…');
    assert.strictEqual(truncate('abcdef', 1), 'a');
    assert.strictEqual(truncate('abcdef', 0), '');
    assert.strictEqual(truncate('abcdef', -3), '');
  });

  it('keeps the terminal width usable even when it is unknown or tiny', async () => {
    await withCapture(() => {
      stdoutColumns = 0;
      Object.defineProperty(process, 'stdout', { value: fakeStdout(), configurable: true });
      assert.strictEqual(terminalWidth(), 100, 'no reported width falls back to 100');

      stdoutColumns = 10;
      Object.defineProperty(process, 'stdout', { value: fakeStdout(), configurable: true });
      assert.strictEqual(terminalWidth(), 40, 'a very narrow terminal is clamped to 40');

      stdoutColumns = 120;
      Object.defineProperty(process, 'stdout', { value: fakeStdout(), configurable: true });
      assert.strictEqual(terminalWidth(), 120);
    });
    stdoutColumns = 100;
  });

  it('writes the message levels with their markers', async () => {
    await withCapture(() => {
      heading('Title');
      info('plain');
      warn('careful');
      error('broken');
      success('done');
    });

    const written = output();
    assert.ok(written.includes('Title'));
    assert.ok(written.includes('plain'));
    assert.ok(written.includes('! careful'));
    assert.ok(written.includes('✖ broken'));
    assert.ok(written.includes('✔ done'));
  });

  it('styles text only when stdout is a terminal', async () => {
    stdoutIsTTY = false;
    await withCapture(() => {
      assert.strictEqual(style.bold('x'), 'x', 'no escapes when output is redirected');
    });

    stdoutIsTTY = true;
    await withCapture(() => {
      // NO_COLOR is honoured too, so accept plain text, but the visible width
      // must be the same either way.
      assert.strictEqual(displayWidth(style.bold('x')), 1);
    });
    stdoutIsTTY = false;
  });
});

// ------------------------------------------------------------- interactive TTY

describe('interactive prompts (a real terminal)', () => {
  let stdin: FakeTTY;

  const press = (name: string, str = ''): void => {
    stdin.emit('keypress', str, { name, ctrl: false, meta: false, shift: false });
  };
  const type = (chars: string): void => {
    for (const char of chars) {
      stdin.emit('keypress', char, { name: char, ctrl: false, meta: false, shift: false });
    }
  };

  const choices: Choice<string>[] = [
    { label: 'alpha', value: 'a', hint: 'first' },
    { label: 'beta', value: 'b' },
    { label: 'Group', value: 'x', separator: true },
    { label: 'gamma', value: 'g' },
  ];

  before(() => {
    stdoutIsTTY = true;
  });

  after(() => {
    stdoutIsTTY = false;
  });

  beforeEach(() => {
    delete process.env.MONGOLITE_NON_INTERACTIVE;
    stdin = new FakeTTY();
    useStdin(stdin);
    readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadableStream);
  });

  it('reports that it is interactive', async () => {
    await withCapture(() => {
      assert.strictEqual(isInteractive(), true);
    });
  });

  it('honours MONGOLITE_NON_INTERACTIVE even on a TTY', async () => {
    await withCapture(() => {
      process.env.MONGOLITE_NON_INTERACTIVE = '1';
      assert.strictEqual(isInteractive(), false);
      delete process.env.MONGOLITE_NON_INTERACTIVE;
    });
  });

  it('returns the highlighted choice on enter', async () => {
    const picked = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 'a');
    assert.ok(output().includes('Pick one'));
  });

  it('moves with the arrow keys and skips separators', async () => {
    const picked = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      press('down'); // beta
      await tick();
      press('down'); // gamma - the separator is stepped over
      await tick();
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 'g');
  });

  it('wraps around when moving up from the top', async () => {
    const picked = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      press('up');
      await tick();
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 'g', 'up from the first entry lands on the last');
  });

  it('jumps to the ends with page up and page down', async () => {
    const last = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      press('pagedown');
      await tick();
      press('return');
      return promise;
    });
    assert.strictEqual(last, 'g');

    const first = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices, initialIndex: 3 });
      await tick();
      press('pageup');
      await tick();
      press('return');
      return promise;
    });
    assert.strictEqual(first, 'a');
  });

  it('starts on initialIndex when one is given', async () => {
    const picked = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices, initialIndex: 1 });
      await tick();
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 'b');
  });

  it('filters as you type', async () => {
    const picked = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      type('gam');
      await tick();
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 'g');
  });

  it('restores the full list when the filter is backspaced away', async () => {
    const picked = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      type('gam');
      await tick();
      press('backspace');
      press('backspace');
      press('backspace');
      await tick();
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 'a', 'clearing the filter shows every choice again');
  });

  it('says so when the filter matches nothing, and enter does nothing', async () => {
    const picked = await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      type('zzz');
      await tick();
      assert.ok(output().includes('no matches'));

      press('return'); // must not resolve - there is nothing to pick
      await tick();
      press('backspace');
      press('backspace');
      press('backspace');
      await tick();
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 'a');
  });

  it('rejects with PromptCancelledError on escape', async () => {
    await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      press('escape');
      await assert.rejects(promise, PromptCancelledError);
    });
  });

  it('exits the process on ctrl+c', async () => {
    await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      promise.catch(() => {
        /* never settles - the real process would already be gone */
      });
      await tick();

      assert.throws(() => {
        stdin.emit('keypress', '', { name: 'c', ctrl: true, meta: false, shift: false });
      }, ExitCalled);
    });
  });

  it('restores the previous raw mode when it finishes', async () => {
    stdin.isRaw = false;
    await withCapture(async () => {
      const promise = select({ message: 'Pick one', choices });
      await tick();
      assert.strictEqual(stdin.isRaw, true, 'raw mode is on while the menu is up');
      press('return');
      return promise;
    });

    assert.strictEqual(stdin.isRaw, false, 'and off again afterwards');
  });

  it('scrolls when there are more choices than fit', async () => {
    const many: Choice<number>[] = Array.from({ length: 30 }, (_, index) => ({
      label: `item-${index}`,
      value: index,
    }));

    const picked = await withCapture(async () => {
      const promise = select({ message: 'Long list', choices: many, pageSize: 5 });
      await tick();
      for (let i = 0; i < 10; i++) {
        press('down');
        await tick();
      }
      press('return');
      return promise;
    });

    assert.strictEqual(picked, 10);
    assert.ok(/…\s*\d+\/30/.test(output()), 'the scroll indicator shows the window position');
  });

  it('truncates entries wider than the terminal', async () => {
    stdoutColumns = 40;
    const picked = await withCapture(async () => {
      const promise = select({
        message: 'Wide',
        choices: [
          { label: 'x'.repeat(200), value: 'wide' },
          { label: 'short', value: 'short' },
        ],
      });
      await tick();
      press('return');
      return promise;
    });
    stdoutColumns = 100;

    assert.strictEqual(picked, 'wide');
    assert.ok(output().includes('…'));
  });

  it('reads a line through a throwaway interface when interactive', async () => {
    const answer = await withCapture(async () => {
      const promise = text({ message: 'Your name' });
      await tick();
      stdin.write('Ada\n');
      return promise;
    });

    assert.strictEqual(answer, 'Ada');
  });
});

// --------------------------------------------------------- non-interactive I/O

describe('fallback prompts (pipes and CI)', () => {
  let stdin: PassThrough;

  before(() => {
    process.env.MONGOLITE_NON_INTERACTIVE = '1';
    stdoutIsTTY = false;
    stdin = new PassThrough();
    useStdin(stdin);
  });

  after(() => {
    delete process.env.MONGOLITE_NON_INTERACTIVE;
    closePrompts();
  });

  /** Queue the answers this prompt will consume, then await it. */
  const answer = <T>(start: () => Promise<T>, ...lines: string[]): Promise<T> =>
    withCapture(() => {
      const promise = start();
      for (const line of lines) stdin.write(`${line}\n`);
      return promise;
    });

  const choices: Choice<string>[] = [
    { label: 'alpha', value: 'a', hint: 'first' },
    { label: 'Group', value: 'x', separator: true },
    { label: 'beta', value: 'b' },
  ];

  it('reports that it is not interactive', async () => {
    await withCapture(() => {
      assert.strictEqual(isInteractive(), false);
    });
  });

  it('numbers the choices and accepts a number', async () => {
    const picked = await answer(() => select({ message: 'Pick one', choices }), '2');
    assert.strictEqual(picked, 'b', 'numbering skips the separator');

    const written = output();
    assert.ok(written.includes('1) alpha'));
    assert.ok(written.includes('2) beta'));
    assert.ok(!written.includes('3)'));
  });

  it('accepts an exact label instead of a number', async () => {
    assert.strictEqual(await answer(() => select({ message: 'Pick one', choices }), 'ALPHA'), 'a');
  });

  it('re-asks until the answer is usable', async () => {
    const picked = await answer(
      () => select({ message: 'Pick one', choices }),
      '', // blank lines are simply ignored
      '9', // out of range
      'nonsense', // not a label either
      '1'
    );
    assert.strictEqual(picked, 'a');
    assert.ok(output().includes('Not a valid choice'));
  });

  it('picks automatically when there is only one option', async () => {
    // No line is consumed - nothing was asked.
    const picked = await withCapture(() =>
      select({ message: 'Only one', choices: [{ label: 'solo', value: 's' }] })
    );
    assert.strictEqual(picked, 's');
    assert.ok(output().includes('(only option)'));
  });

  it('refuses to ask about an empty list', async () => {
    await assert.rejects(
      withCapture(() => select({ message: 'Nothing here', choices: [] })),
      /Nothing to choose from for: Nothing here/
    );
  });

  it('reads free text, falling back to the default on a blank line', async () => {
    assert.strictEqual(await answer(() => text({ message: 'Name' }), 'Ada'), 'Ada');
    assert.strictEqual(
      await answer(() => text({ message: 'Name', defaultValue: 'Grace' }), ''),
      'Grace'
    );
    assert.strictEqual(await answer(() => text({ message: 'Name', allowEmpty: true }), ''), '');
  });

  it('insists on a value when one is required', async () => {
    assert.strictEqual(await answer(() => text({ message: 'Name' }), '', '  ', 'Ada'), 'Ada');
    assert.ok(output().includes('A value is required'));
  });

  it('re-prompts until validation passes, and shows the hint', async () => {
    const value = await answer(
      () =>
        text({
          message: 'Age',
          hint: 'a whole number please',
          validate: (input) => (/^\d+$/.test(input) ? undefined : 'Numbers only.'),
        }),
      'abc',
      '42'
    );
    assert.strictEqual(value, '42');
    assert.ok(output().includes('a whole number please'));
    assert.ok(output().includes('Numbers only.'));
  });

  it('reads multi-line input up to a blank line', async () => {
    const value = await answer(() => multilineText('SQL to run'), 'SELECT 1', 'FROM t', '');
    assert.strictEqual(value, 'SELECT 1\nFROM t');
  });

  it('confirms with yes, no and defaults', async () => {
    assert.strictEqual(await answer(() => confirm('Sure?'), 'y'), true);
    assert.strictEqual(await answer(() => confirm('Sure?'), 'YES'), true);
    assert.strictEqual(await answer(() => confirm('Sure?'), 'n'), false);
    assert.strictEqual(await answer(() => confirm('Sure?'), 'anything else'), false);
    assert.strictEqual(await answer(() => confirm('Sure?'), ''), false, 'defaults to no');
    assert.strictEqual(await answer(() => confirm('Sure?', true), ''), true, 'defaults to yes');
  });

  it('pauses until a line arrives', async () => {
    await answer(() => pause(), '');
    assert.ok(output().includes('Press enter to continue'));
  });

  it('reads lines that were buffered before anything asked for them', async () => {
    // A piped script delivers every answer at once, long before the later
    // prompts are reached; they must not be dropped.
    await withCapture(async () => {
      stdin.write('first\nsecond\n');
      await tick();
      assert.strictEqual(await text({ message: 'One' }), 'first');
      assert.strictEqual(await text({ message: 'Two' }), 'second');
    });
  });

  it('stops rather than spinning when the input runs out', async () => {
    const ended = new PassThrough();
    useStdin(ended);
    closePrompts();

    await withCapture(async () => {
      const promise = text({ message: 'Never answered' });
      ended.end();
      await assert.rejects(promise, ExitCalled);
    });

    closePrompts();
    useStdin(stdin);
  });
});
