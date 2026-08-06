/**
 * Small, dependency-free terminal UI helpers used by the guided MongoLite CLI.
 *
 * Everything degrades gracefully:
 * - When stdin/stdout is a TTY the prompts are interactive (arrow keys, filtering).
 * - When it is not (pipes, CI, dumb terminals) the same prompts fall back to a
 *   numbered list read line-by-line, so the CLI stays scriptable.
 */
import * as readline from 'node:readline';

const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';

export const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.MONGOLITE_NON_INTERACTIVE);

const wrap =
  (open: string, close: string) =>
  (text: string): string =>
    NO_COLOR || !process.stdout.isTTY ? text : `\u001b[${open}m${text}\u001b[${close}m`;

export const style = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  grey: wrap('90', '39'),
};

/** Visible width of a string, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

/** Truncate to `max` visible characters, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

export function terminalWidth(): number {
  return Math.max(40, process.stdout.columns || 100);
}

export interface Choice<T> {
  /** Text shown in the list. */
  label: string;
  /** Value returned when the choice is picked. */
  value: T;
  /** Dimmed text shown to the right of the label. */
  hint?: string;
  /** Renders as a non-selectable heading. */
  separator?: boolean;
}

export interface SelectOptions<T> {
  message: string;
  choices: Choice<T>[];
  pageSize?: number;
  initialIndex?: number;
  /** Extra guidance rendered under the question. */
  hint?: string;
}

/** Thrown when the user aborts a prompt with Esc or Ctrl+C. */
export class PromptCancelledError extends Error {
  constructor() {
    super('Prompt cancelled');
    this.name = 'PromptCancelledError';
  }
}

function selectableIndexes<T>(choices: Choice<T>[]): number[] {
  return choices.map((c, i) => (c.separator ? -1 : i)).filter((i) => i >= 0);
}

/**
 * Ask the user to pick one of `choices`.
 * Interactive terminals get an arrow-key menu with type-to-filter; everything
 * else gets a numbered list.
 */
export async function select<T>(options: SelectOptions<T>): Promise<T> {
  if (options.choices.length === 0) {
    throw new Error(`Nothing to choose from for: ${options.message}`);
  }
  const selectable = selectableIndexes(options.choices);
  if (selectable.length === 1 && options.choices.length === 1) {
    // Nothing to decide - tell the user what was picked for them and move on.
    const only = options.choices[selectable[0]];
    process.stdout.write(
      `${style.green('?')} ${style.bold(options.message)} ${style.cyan(only.label)} ${style.grey('(only option)')}\n`
    );
    return only.value;
  }
  return isInteractive() ? interactiveSelect(options) : fallbackSelect(options);
}

async function interactiveSelect<T>(options: SelectOptions<T>): Promise<T> {
  const { message, choices } = options;
  const pageSize = Math.min(options.pageSize ?? 12, Math.max(3, (process.stdout.rows || 24) - 6));

  let filter = '';
  let cursor = 0;
  let renderedLines = 0;

  const visible = (): { choice: Choice<T>; index: number }[] => {
    const lowered = filter.toLowerCase();
    return choices
      .map((choice, index) => ({ choice, index }))
      .filter(({ choice }) => {
        if (!filter) return true;
        if (choice.separator) return false;
        return `${choice.label} ${choice.hint ?? ''}`.toLowerCase().includes(lowered);
      });
  };

  const selectablePositions = (list: ReturnType<typeof visible>): number[] =>
    list.map((entry, pos) => (entry.choice.separator ? -1 : pos)).filter((pos) => pos >= 0);

  const initial = options.initialIndex ?? 0;
  {
    const list = visible();
    const positions = selectablePositions(list);
    const wanted = list.findIndex((entry) => entry.index === initial);
    cursor = positions.includes(wanted) ? wanted : (positions[0] ?? 0);
  }

  const clear = (): void => {
    if (renderedLines > 0) {
      process.stdout.write(`\u001b[${renderedLines}A`);
      process.stdout.write('\u001b[0J');
    }
    renderedLines = 0;
  };

  const render = (): void => {
    clear();
    const width = terminalWidth();
    const list = visible();
    const positions = selectablePositions(list);
    if (positions.length && !positions.includes(cursor)) {
      cursor = positions[0];
    }

    const lines: string[] = [];
    const filterSuffix = filter ? ` ${style.yellow(`/${filter}`)}` : '';
    lines.push(`${style.green('?')} ${style.bold(message)}${filterSuffix}`);
    lines.push(
      style.grey(options.hint ?? '  ↑/↓ move · type to filter · enter to select · esc to go back')
    );

    // Scroll window so the cursor stays visible.
    let start = 0;
    if (list.length > pageSize) {
      start = Math.min(Math.max(0, cursor - Math.floor(pageSize / 2)), list.length - pageSize);
    }
    const window = list.slice(start, start + pageSize);

    if (window.length === 0) {
      lines.push(style.grey('  no matches'));
    }

    window.forEach((entry, offset) => {
      const pos = start + offset;
      const { choice } = entry;
      if (choice.separator) {
        lines.push(style.grey(`  ${choice.label}`));
        return;
      }
      const active = pos === cursor;
      const pointer = active ? style.cyan('❯') : ' ';
      const label = active ? style.cyan(choice.label) : choice.label;
      const hint = choice.hint ? ` ${style.grey(choice.hint)}` : '';
      const line = `${pointer} ${label}${hint}`;
      lines.push(displayWidth(line) > width ? truncate(line, width) : line);
    });

    if (list.length > pageSize) {
      lines.push(style.grey(`  … ${start + window.length}/${list.length}`));
    }

    process.stdout.write(`${lines.join('\n')}\n`);
    renderedLines = lines.length;
  };

  return new Promise<T>((resolve, reject) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (fn: () => void): void => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      fn();
    };

    const onKeypress = (str: string, key: readline.Key): void => {
      const list = visible();
      const positions = selectablePositions(list);

      if (key.ctrl && key.name === 'c') {
        clear();
        finish(() => {
          process.stdout.write(style.grey('Cancelled.\n'));
          process.exit(0);
        });
        return;
      }

      switch (key.name) {
        case 'escape':
          clear();
          finish(() => reject(new PromptCancelledError()));
          return;
        case 'up': {
          const at = positions.indexOf(cursor);
          cursor = positions[(at - 1 + positions.length) % positions.length] ?? cursor;
          render();
          return;
        }
        case 'down': {
          const at = positions.indexOf(cursor);
          cursor = positions[(at + 1) % positions.length] ?? cursor;
          render();
          return;
        }
        case 'pageup':
          cursor = positions[0] ?? cursor;
          render();
          return;
        case 'pagedown':
          cursor = positions[positions.length - 1] ?? cursor;
          render();
          return;
        case 'return':
        case 'enter': {
          const chosen = list[cursor];
          if (!chosen || chosen.choice.separator) return;
          clear();
          process.stdout.write(
            `${style.green('?')} ${style.bold(message)} ${style.cyan(chosen.choice.label)}\n`
          );
          finish(() => resolve(chosen.choice.value));
          return;
        }
        case 'backspace':
          filter = filter.slice(0, -1);
          render();
          return;
        default:
          break;
      }

      if (str && !key.ctrl && !key.meta && str >= ' ' && str <= '~') {
        filter += str;
        render();
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}

async function fallbackSelect<T>(options: SelectOptions<T>): Promise<T> {
  const { message, choices } = options;
  const numbered = choices
    .map((choice, index) => ({ choice, index }))
    .filter((e) => !e.choice.separator);

  process.stdout.write(`\n${style.bold(message)}\n`);
  numbered.forEach((entry, position) => {
    const hint = entry.choice.hint ? ` ${style.grey(entry.choice.hint)}` : '';
    process.stdout.write(`  ${position + 1}) ${entry.choice.label}${hint}\n`);
  });

  for (;;) {
    const answer = (await question(`Choose 1-${numbered.length}: `)).trim();
    if (answer === '') continue;
    const position = Number.parseInt(answer, 10);
    if (Number.isInteger(position) && position >= 1 && position <= numbered.length) {
      return numbered[position - 1].choice.value;
    }
    // Also accept an exact (case-insensitive) label so scripted input stays readable.
    const byLabel = numbered.find(
      (entry) => entry.choice.label.toLowerCase() === answer.toLowerCase()
    );
    if (byLabel) return byLabel.choice.value;
    process.stdout.write(style.red('  Not a valid choice, try again.\n'));
  }
}

/**
 * A single readline interface is reused for line input when stdin is not a
 * TTY. Creating one per prompt would work for a human typing, but a *piped*
 * script has all its answers buffered at once: closing the interface after the
 * first question discards every remaining line. Interactive sessions still get
 * a throwaway interface per prompt so they can coexist with the raw-mode
 * keypress handling in `select`.
 */
let sharedInterface: readline.Interface | null = null;
let stdinEnded = false;
/** Lines that arrived before anything asked for them. */
const bufferedLines: string[] = [];
/** Callbacks waiting for the next line; `null` means stdin ended first. */
const lineWaiters: ((line: string | null) => void)[] = [];

function getSharedInterface(): readline.Interface {
  if (!sharedInterface) {
    sharedInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // Queue every line as it arrives. Piped input delivers all of its lines
    // immediately, long before the later prompts ask for them.
    sharedInterface.on('line', (line) => {
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else bufferedLines.push(line);
    });
    sharedInterface.on('close', () => {
      stdinEnded = true;
      while (lineWaiters.length > 0) lineWaiters.shift()?.(null);
    });
  }
  return sharedInterface;
}

/** Release the shared interface so the process can exit. */
export function closePrompts(): void {
  sharedInterface?.close();
  sharedInterface = null;
}

/** Read a single line from stdin. */
export function question(prompt: string): Promise<string> {
  if (isInteractive()) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  getSharedInterface();
  process.stdout.write(prompt);

  const buffered = bufferedLines.shift();
  if (buffered !== undefined) {
    process.stdout.write(`${buffered}\n`);
    return Promise.resolve(buffered);
  }

  if (stdinEnded) {
    // Input is exhausted - carrying on would spin forever re-asking.
    process.stdout.write(`\n${style.grey('Input ended.')}\n`);
    process.exit(0);
  }

  return new Promise((resolve) => {
    lineWaiters.push((line) => {
      if (line === null) {
        process.stdout.write(`\n${style.grey('Input ended.')}\n`);
        process.exit(0);
      }
      resolve(line);
    });
  });
}

export interface TextOptions {
  message: string;
  defaultValue?: string;
  /** Return an error string to re-prompt, or undefined when the value is fine. */
  validate?: (value: string) => string | undefined;
  allowEmpty?: boolean;
  hint?: string;
}

/** Ask for free-text input, re-prompting until `validate` is happy. */
export async function text(options: TextOptions): Promise<string> {
  const suffix = options.defaultValue ? style.grey(` (${options.defaultValue})`) : '';
  if (options.hint) process.stdout.write(`${style.grey(options.hint)}\n`);

  for (;;) {
    const raw = await question(`${style.green('?')} ${style.bold(options.message)}${suffix} `);
    const value = raw.trim() === '' ? (options.defaultValue ?? '') : raw.trim();

    if (value === '' && !options.allowEmpty && !options.defaultValue) {
      process.stdout.write(style.red('  A value is required.\n'));
      continue;
    }
    const error = options.validate?.(value);
    if (error) {
      process.stdout.write(`${style.red(`  ${error}`)}\n`);
      continue;
    }
    return value;
  }
}

/** Ask for multi-line input; a blank line ends the entry. */
export async function multilineText(message: string): Promise<string> {
  process.stdout.write(`${style.green('?')} ${style.bold(message)}\n`);
  process.stdout.write(style.grey('  Finish with an empty line.\n'));
  const lines: string[] = [];
  for (;;) {
    const line = await question('  ');
    if (line.trim() === '') break;
    lines.push(line);
  }
  return lines.join('\n');
}

export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (
    await question(`${style.green('?')} ${style.bold(message)} ${style.grey(`(${hint})`)} `)
  )
    .trim()
    .toLowerCase();
  if (answer === '') return defaultValue;
  return answer === 'y' || answer === 'yes';
}

/** Wait for the user before scrolling more output past them. */
export async function pause(message = 'Press enter to continue'): Promise<void> {
  await question(style.grey(`${message} `));
}

export function heading(text: string): void {
  process.stdout.write(`\n${style.bold(style.underline(text))}\n`);
}

export function info(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stdout.write(`${style.yellow('!')} ${text}\n`);
}

export function error(text: string): void {
  process.stdout.write(`${style.red('✖')} ${text}\n`);
}

export function success(text: string): void {
  process.stdout.write(`${style.green('✔')} ${text}\n`);
}
