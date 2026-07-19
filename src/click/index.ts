/**
 * Mini-click: a TypeScript stand-in for the parts of Python's click that
 * llm's CLI uses — command groups (with click-default-group behavior),
 * option/argument parsing, help output, ClickException handling, echo
 * with ANSI stripping, and a CliRunner test harness that captures
 * stdout/stderr/mixed output like click 8.2+.
 *
 * Command handlers are async functions receiving (params, ctx).
 */

import * as fs from "node:fs";

// ------------------------------------------------------------ exceptions

export class ClickException extends Error {
  exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = "ClickException";
  }

  formatMessage(): string {
    return this.message;
  }

  show(write: (s: string) => void): void {
    write(`Error: ${this.formatMessage()}\n`);
  }
}

export class UsageError extends ClickException {
  override exitCode = 2;
  ctx: Context | null = null;

  override show(write: (s: string) => void): void {
    if (this.ctx) {
      write(this.ctx.getUsage() + "\n");
      const commandPath = this.ctx.commandPath;
      write(`Try '${commandPath} --help' for help.\n\n`);
    }
    write(`Error: ${this.formatMessage()}\n`);
  }
}

export class BadParameter extends UsageError {
  paramHint: string | null;

  constructor(message: string, paramHint: string | null = null) {
    super(message);
    this.paramHint = paramHint;
  }

  override formatMessage(): string {
    if (this.paramHint) {
      return `Invalid value for ${this.paramHint}: ${this.message}`;
    }
    return `Invalid value: ${this.message}`;
  }
}

export class NoSuchOption extends UsageError {
  constructor(optionName: string) {
    super(`No such option: ${optionName}`);
  }
}

export class Abort extends Error {
  constructor() {
    super("Aborted!");
    this.name = "Abort";
  }
}

export class Exit extends Error {
  code: number;

  constructor(code = 0) {
    super(`Exit: ${code}`);
    this.name = "Exit";
    this.code = code;
  }
}

// ------------------------------------------------------------ IO streams

export interface IOStreams {
  writeOut(text: string): void;
  writeErr(text: string): void;
  /** Read all remaining stdin. */
  readStdin(): string;
  /** Read all remaining stdin as binary. */
  readStdinBuffer(): Buffer;
  stdinIsTty(): boolean;
  /** Read one line (for prompt/confirm); null on EOF. */
  readLine(): string | null;
  color: boolean;
}

class ProcessStreams implements IOStreams {
  color =
    Boolean(process.stdout.isTTY) && !process.env.NO_COLOR ? true : false;
  private stdinBuffer: string | null = null;
  private stdinPos = 0;

  writeOut(text: string): void {
    process.stdout.write(text);
  }

  writeErr(text: string): void {
    process.stderr.write(text);
  }

  readStdinBuffer(): Buffer {
    try {
      return fs.readFileSync(0);
    } catch {
      return Buffer.alloc(0);
    }
  }

  readStdin(): string {
    if (this.stdinBuffer === null) {
      try {
        this.stdinBuffer = fs.readFileSync(0, "utf-8");
      } catch {
        this.stdinBuffer = "";
      }
      this.stdinPos = this.stdinBuffer.length;
    }
    return this.stdinBuffer;
  }

  stdinIsTty(): boolean {
    return Boolean(process.stdin.isTTY);
  }

  readLine(): string | null {
    const all = this.readStdin();
    if (this.stdinPos >= all.length) return null;
    const idx = all.indexOf("\n", this.stdinPos);
    let line: string;
    if (idx === -1) {
      line = all.slice(this.stdinPos);
      this.stdinPos = all.length;
    } else {
      line = all.slice(this.stdinPos, idx);
      this.stdinPos = idx + 1;
    }
    return line;
  }
}

let currentStreams: IOStreams = new ProcessStreams();

export function setStreams(streams: IOStreams): IOStreams {
  const prev = currentStreams;
  currentStreams = streams;
  return prev;
}

export function getStreams(): IOStreams {
  return currentStreams;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function echo(
  message: unknown = "",
  {
    nl = true,
    err = false,
    color = null,
  }: { nl?: boolean; err?: boolean; color?: boolean | null } = {},
): void {
  let text = message === null || message === undefined ? "" : String(message);
  if (nl) text += "\n";
  const useColor = color ?? currentStreams.color;
  if (!useColor) {
    text = stripAnsi(text);
  }
  if (err) {
    currentStreams.writeErr(text);
  } else {
    currentStreams.writeOut(text);
  }
}

const STYLE_CODES: Record<string, [string, string]> = {
  bold: ["\x1b[1m", "\x1b[22m"],
  dim: ["\x1b[2m", "\x1b[22m"],
  underline: ["\x1b[4m", "\x1b[24m"],
  italic: ["\x1b[3m", "\x1b[23m"],
  blink: ["\x1b[5m", "\x1b[25m"],
  reverse: ["\x1b[7m", "\x1b[27m"],
};

const FG_COLORS: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  bright_black: 90,
  bright_red: 91,
  bright_green: 92,
  bright_yellow: 93,
  bright_blue: 94,
  bright_magenta: 95,
  bright_cyan: 96,
  bright_white: 97,
};

export function style(
  text: string,
  {
    fg = null,
    bold = false,
    dim = false,
    underline = false,
    italic = false,
    reset = true,
  }: {
    fg?: string | null;
    bold?: boolean;
    dim?: boolean;
    underline?: boolean;
    italic?: boolean;
    reset?: boolean;
  } = {},
): string {
  let prefix = "";
  if (fg && fg in FG_COLORS) {
    prefix += `\x1b[${FG_COLORS[fg]}m`;
  }
  if (bold) prefix += STYLE_CODES.bold[0];
  if (dim) prefix += STYLE_CODES.dim[0];
  if (underline) prefix += STYLE_CODES.underline[0];
  if (italic) prefix += STYLE_CODES.italic[0];
  return prefix + text + (reset ? "\x1b[0m" : "");
}

export function prompt(
  text: string,
  {
    default: defaultValue = null,
    hideInput = false,
  }: { default?: string | null; hideInput?: boolean } = {},
): string {
  void hideInput;
  currentStreams.writeErr(`${text}: `);
  const line = currentStreams.readLine();
  if (line === null) {
    if (defaultValue !== null) return defaultValue;
    throw new Abort();
  }
  return line;
}

export function confirm(text: string): boolean {
  currentStreams.writeErr(`${text} [y/N]: `);
  const line = currentStreams.readLine();
  return line !== null && ["y", "yes"].includes(line.trim().toLowerCase());
}

/** click.edit stand-in — no interactive editor in this environment. */
export function edit(_text?: string): string | null {
  return null;
}

// ---------------------------------------------------------- param types

export type ParamTypeName = "string" | "int" | "float" | "bool";

export class Choice {
  choices: string[];

  constructor(choices: Iterable<string>) {
    this.choices = [...choices];
  }
}

export class Path {
  exists: boolean;
  allowDash: boolean;
  dirOkay: boolean;
  fileOkay: boolean;
  writable: boolean;
  readable: boolean;

  constructor({
    exists = false,
    allowDash = false,
    dirOkay = true,
    fileOkay = true,
    writable = false,
    readable = true,
  }: {
    exists?: boolean;
    allowDash?: boolean;
    dirOkay?: boolean;
    fileOkay?: boolean;
    writable?: boolean;
    readable?: boolean;
  } = {}) {
    this.exists = exists;
    this.allowDash = allowDash;
    this.dirOkay = dirOkay;
    this.fileOkay = fileOkay;
    this.writable = writable;
    this.readable = readable;
  }
}

export class File {
  mode: string;

  constructor(mode = "r") {
    this.mode = mode;
  }
}

export type ParamType = ParamTypeName | Choice | Path | File;

function convertValue(
  value: string,
  type: ParamType,
  paramHint: string,
  paramName: string,
): unknown {
  if (type === "string") return value;
  if (type === "int") {
    if (!/^[+-]?\d+$/.test(value.trim())) {
      throw new BadParameter(
        `'${value}' is not a valid integer.`,
        paramHint,
      );
    }
    return parseInt(value, 10);
  }
  if (type === "float") {
    const f = Number(value);
    if (Number.isNaN(f) || value.trim() === "") {
      throw new BadParameter(`'${value}' is not a valid float.`, paramHint);
    }
    return f;
  }
  if (type === "bool") {
    const lower = value.toLowerCase();
    if (["true", "1", "yes", "y", "on", "t"].includes(lower)) return true;
    if (["false", "0", "no", "n", "off", "f"].includes(lower)) return false;
    throw new BadParameter(`'${value}' is not a valid boolean.`, paramHint);
  }
  if (type instanceof Choice) {
    if (!type.choices.includes(value)) {
      throw new BadParameter(
        `'${value}' is not one of ${type.choices
          .map((c) => `'${c}'`)
          .join(", ")}.`,
        paramHint,
      );
    }
    return value;
  }
  if (type instanceof Path) {
    if (type.allowDash && value === "-") return value;
    if (type.exists && !fs.existsSync(value)) {
      const kind = type.dirOkay && !type.fileOkay ? "Directory" : "File";
      throw new BadParameter(
        `${kind} '${value}' does not exist.`,
        paramHint,
      );
    }
    if (type.exists && !type.dirOkay && fs.existsSync(value)) {
      if (fs.statSync(value).isDirectory()) {
        throw new BadParameter(`File '${value}' is a directory.`, paramHint);
      }
    }
    if (type.exists && !type.fileOkay && fs.existsSync(value)) {
      if (fs.statSync(value).isFile()) {
        throw new BadParameter(
          `Directory '${value}' is a file.`,
          paramHint,
        );
      }
    }
    return value;
  }
  if (type instanceof File) {
    return value; // handlers open lazily via readFileOrStdin helpers
  }
  void paramName;
  return value;
}

function typeMetavar(type: ParamType): string {
  if (type === "int") return "INTEGER";
  if (type === "float") return "FLOAT";
  if (type === "bool") return "BOOLEAN";
  if (type instanceof Choice) return `[${type.choices.join("|")}]`;
  if (type instanceof Path) return "PATH";
  if (type instanceof File) return "FILENAME";
  return "TEXT";
}

// ------------------------------------------------------------- parameters

export interface OptionInit {
  /** e.g. ["-s", "--system"] plus optional trailing param name override */
  flags: string[];
  /** explicit parameter name (defaults from the longest flag) */
  name?: string;
  type?: ParamType;
  isFlag?: boolean;
  /** for "--foo/--no-foo" style flags */
  flagValue?: unknown;
  default?: unknown;
  multiple?: boolean;
  nargs?: number;
  required?: boolean;
  help?: string;
  hidden?: boolean;
  envvar?: string;
  callback?: (ctx: Context, param: Option, value: unknown) => unknown;
  /** secondary flags that set the value to false, e.g. --no-log */
  secondaryFlags?: string[];
}

export class Option {
  flags: string[];
  secondaryFlags: string[];
  name: string;
  type: ParamType;
  isFlag: boolean;
  default: unknown;
  multiple: boolean;
  nargs: number;
  required: boolean;
  help: string;
  hidden: boolean;
  envvar: string | null;
  callback: ((ctx: Context, param: Option, value: unknown) => unknown) | null;

  constructor(init: OptionInit) {
    this.flags = init.flags;
    this.secondaryFlags = init.secondaryFlags ?? [];
    const longest = [...init.flags]
      .filter((f) => f.startsWith("--"))
      .sort((a, b) => b.length - a.length)[0];
    this.name =
      init.name ??
      (longest ?? init.flags[0]).replace(/^--?/, "").replace(/-/g, "_");
    this.type = init.type ?? "string";
    this.isFlag = init.isFlag ?? false;
    this.default =
      init.default !== undefined
        ? init.default
        : this.isFlag
          ? false
          : init.multiple
            ? []
            : null;
    this.multiple = init.multiple ?? false;
    this.nargs = init.nargs ?? 1;
    this.required = init.required ?? false;
    this.help = init.help ?? "";
    this.hidden = init.hidden ?? false;
    this.envvar = init.envvar ?? null;
    this.callback = init.callback ?? null;
  }

  get paramHint(): string {
    return `'${this.flags.join("' / '")}'`;
  }
}

export interface ArgumentInit {
  name: string;
  type?: ParamType;
  required?: boolean;
  nargs?: number; // -1 = variadic
  default?: unknown;
  callback?: (ctx: Context, param: Argument, value: unknown) => unknown;
}

export class Argument {
  name: string;
  type: ParamType;
  required: boolean;
  nargs: number;
  default: unknown;
  callback:
    | ((ctx: Context, param: Argument, value: unknown) => unknown)
    | null;

  constructor(init: ArgumentInit) {
    this.name = init.name;
    this.type = init.type ?? "string";
    this.nargs = init.nargs ?? 1;
    this.required = init.required ?? this.nargs !== -1;
    this.default = init.default ?? (this.nargs === -1 ? [] : null);
    this.callback = init.callback ?? null;
  }

  get paramHint(): string {
    return `'${this.name.toUpperCase()}'`;
  }
}

// --------------------------------------------------------------- context

export class Context {
  command: Command;
  parent: Context | null;
  params: Record<string, unknown> = {};
  obj: unknown = null;
  infoName: string;

  constructor(command: Command, parent: Context | null = null, infoName?: string) {
    this.command = command;
    this.parent = parent;
    this.infoName = infoName ?? command.name;
    if (parent) {
      this.obj = parent.obj;
    }
  }

  get commandPath(): string {
    if (this.parent) {
      return `${this.parent.commandPath} ${this.infoName}`;
    }
    return this.infoName;
  }

  exit(code = 0): never {
    throw new Exit(code);
  }

  getUsage(): string {
    return this.command.getUsage(this);
  }

  getHelp(): string {
    return this.command.getHelp(this);
  }
}

// --------------------------------------------------------------- command

export type Handler = (
  params: Record<string, any>,
  ctx: Context,
) => unknown | Promise<unknown>;

export interface CommandInit {
  name: string;
  help?: string;
  shortHelp?: string;
  options?: Option[];
  arguments?: Argument[];
  handler?: Handler;
  hidden?: boolean;
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (indent + line + " " + word).length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}

export class Command {
  name: string;
  help: string;
  shortHelp: string;
  options: Option[];
  args: Argument[];
  handler: Handler | null;
  hidden: boolean;

  constructor(init: CommandInit) {
    this.name = init.name;
    this.help = init.help ?? "";
    this.shortHelp =
      init.shortHelp ?? (init.help ? init.help.split("\n\n")[0].trim().split("\n")[0] : "");
    this.options = init.options ?? [];
    this.args = init.arguments ?? [];
    this.handler = init.handler ?? null;
    this.hidden = init.hidden ?? false;
  }

  getUsage(ctx: Context): string {
    const pieces: string[] = ["Usage:", ctx.commandPath, "[OPTIONS]"];
    for (const arg of this.args) {
      let metavar = arg.name.toUpperCase();
      if (arg.nargs === -1) {
        metavar = `[${metavar}]...`;
      } else if (!arg.required) {
        metavar = `[${metavar}]`;
      }
      pieces.push(metavar);
    }
    if (this instanceof Group) {
      pieces.push("COMMAND [ARGS]...");
    }
    return pieces.join(" ");
  }

  getHelp(ctx: Context): string {
    const bits: string[] = [this.getUsage(ctx), ""];
    if (this.help) {
      const lines = this.help.split("\n");
      // De-indent like Python docstrings
      const dedented = lines
        .map((l, i) => (i === 0 ? l : l.replace(/^\s{0,4}/, "")))
        .join("\n");
      bits.push(dedented.trim());
      bits.push("");
    }
    bits.push("Options:");
    for (const option of this.options) {
      if (option.hidden) continue;
      let flagsCombined = [...option.flags]
        .sort((a, b) => a.length - b.length)
        .join(", ");
      if (option.secondaryFlags.length) {
        flagsCombined += "/" + option.secondaryFlags.join("/");
      }
      if (!option.isFlag) {
        flagsCombined += " " + typeMetavar(option.type);
      }
      const helpText = option.help;
      if (flagsCombined.length <= 22 && helpText) {
        bits.push(
          `  ${flagsCombined.padEnd(22)}  ${helpText}`,
        );
      } else if (helpText) {
        bits.push(`  ${flagsCombined}`);
        bits.push(wrapText(helpText, 78, "        "));
      } else {
        bits.push(`  ${flagsCombined}`);
      }
    }
    bits.push("  --help".padEnd(24) + "  Show this message and exit.");
    if (this instanceof Group) {
      bits.push("");
      bits.push("Commands:");
      const names = [...this.commands.keys()].sort();
      for (const name of names) {
        const cmd = this.commands.get(name)!;
        if (cmd.hidden) continue;
        bits.push(`  ${name.padEnd(12)}  ${cmd.shortHelp}`);
      }
    }
    return bits.join("\n");
  }

  /** Parse args and run. Throws Exit / ClickException. */
  async invoke(ctx: Context, argv: string[]): Promise<unknown> {
    const params = this.parseArgs(ctx, argv);
    if (params === HELP_SENTINEL) {
      echo(this.getHelp(ctx));
      throw new Exit(0);
    }
    ctx.params = params as Record<string, unknown>;
    if (!this.handler) {
      echo(this.getHelp(ctx));
      throw new Exit(0);
    }
    return await this.handler(ctx.params, ctx);
  }

  protected parseArgs(
    ctx: Context,
    argv: string[],
  ): Record<string, unknown> | typeof HELP_SENTINEL {
    const params: Record<string, unknown> = {};
    const positional: string[] = [];
    const optionByFlag = new Map<string, { option: Option; secondary: boolean }>();
    for (const option of this.options) {
      for (const flag of option.flags) {
        optionByFlag.set(flag, { option, secondary: false });
      }
      for (const flag of option.secondaryFlags) {
        optionByFlag.set(flag, { option, secondary: true });
      }
    }

    const collected = new Map<Option, unknown[]>();

    let i = 0;
    let afterDoubleDash = false;
    while (i < argv.length) {
      const token = argv[i];
      if (token === "--" && !afterDoubleDash) {
        afterDoubleDash = true;
        i++;
        continue;
      }
      if (!afterDoubleDash && (token === "--help" || token === "-h")) {
        if (token === "--help") {
          return HELP_SENTINEL;
        }
      }
      if (
        !afterDoubleDash &&
        token.startsWith("--") &&
        token.length > 2
      ) {
        let flag = token;
        let inlineValue: string | null = null;
        const eq = token.indexOf("=");
        if (eq !== -1) {
          flag = token.slice(0, eq);
          inlineValue = token.slice(eq + 1);
        }
        const entry = optionByFlag.get(flag);
        if (!entry) {
          const err = new NoSuchOption(flag);
          err.ctx = ctx;
          throw err;
        }
        i++;
        i = this.consumeOption(
          ctx,
          entry,
          argv,
          i,
          inlineValue,
          collected,
        );
        continue;
      }
      if (
        !afterDoubleDash &&
        token.startsWith("-") &&
        token !== "-" &&
        !/^-\d/.test(token)
      ) {
        // Short option(s), possibly combined
        let rest = token.slice(1);
        i++;
        while (rest.length) {
          const flag = "-" + rest[0];
          rest = rest.slice(1);
          const entry = optionByFlag.get(flag);
          if (!entry) {
            const err = new NoSuchOption(flag);
            err.ctx = ctx;
            throw err;
          }
          if (entry.option.isFlag) {
            i = this.consumeOption(ctx, entry, argv, i, null, collected);
          } else {
            const inline = rest.length ? rest : null;
            rest = "";
            i = this.consumeOption(ctx, entry, argv, i, inline, collected);
          }
        }
        continue;
      }
      positional.push(token);
      i++;
    }

    // Assign option values
    for (const option of this.options) {
      const values = collected.get(option);
      let value: unknown;
      if (values === undefined || values.length === 0) {
        if (option.envvar && process.env[option.envvar] !== undefined) {
          value = option.isFlag
            ? true
            : convertValue(
                process.env[option.envvar]!,
                option.type,
                option.paramHint,
                option.name,
              );
        } else if (option.required) {
          const err = new UsageError(`Missing option ${option.paramHint}.`);
          err.ctx = ctx;
          throw err;
        } else {
          value = option.default;
        }
      } else if (option.multiple) {
        value = values;
      } else {
        value = values[values.length - 1];
      }
      if (option.callback) {
        value = option.callback(ctx, option, value);
      }
      params[option.name] = value;
    }

    // Assign positional arguments
    let pos = 0;
    for (let a = 0; a < this.args.length; a++) {
      const arg = this.args[a];
      if (arg.nargs === -1) {
        // Variadic: take everything except what later fixed args need
        const remainingFixed = this.args
          .slice(a + 1)
          .reduce((acc, x) => acc + (x.nargs === -1 ? 0 : x.nargs), 0);
        const take = Math.max(0, positional.length - pos - remainingFixed);
        const items = positional
          .slice(pos, pos + take)
          .map((v) => convertValue(v, arg.type, arg.paramHint, arg.name));
        pos += take;
        let value: unknown = items;
        if (arg.callback) {
          value = arg.callback(ctx, arg, value);
        }
        params[arg.name] = value;
      } else if (arg.nargs === 1) {
        if (pos < positional.length) {
          let value: unknown = convertValue(
            positional[pos],
            arg.type,
            arg.paramHint,
            arg.name,
          );
          pos++;
          if (arg.callback) {
            value = arg.callback(ctx, arg, value);
          }
          params[arg.name] = value;
        } else if (arg.required) {
          const err = new UsageError(
            `Missing argument ${arg.paramHint}.`,
          );
          err.ctx = ctx;
          throw err;
        } else {
          let value = arg.default;
          if (arg.callback) {
            value = arg.callback(ctx, arg, value);
          }
          params[arg.name] = value;
        }
      } else {
        const items: unknown[] = [];
        for (let n = 0; n < arg.nargs; n++) {
          if (pos < positional.length) {
            items.push(
              convertValue(positional[pos], arg.type, arg.paramHint, arg.name),
            );
            pos++;
          } else if (arg.required) {
            const err = new UsageError(
              `Missing argument ${arg.paramHint}.`,
            );
            err.ctx = ctx;
            throw err;
          }
        }
        params[arg.name] = items;
      }
    }
    if (pos < positional.length) {
      const err = new UsageError(
        `Got unexpected extra argument${
          positional.length - pos === 1 ? "" : "s"
        } (${positional.slice(pos).join(" ")})`,
      );
      err.ctx = ctx;
      throw err;
    }

    return params;
  }

  private consumeOption(
    ctx: Context,
    entry: { option: Option; secondary: boolean },
    argv: string[],
    i: number,
    inlineValue: string | null,
    collected: Map<Option, unknown[]>,
  ): number {
    const { option, secondary } = entry;
    if (!collected.has(option)) {
      collected.set(option, []);
    }
    const bucket = collected.get(option)!;
    if (option.isFlag) {
      bucket.push(!secondary);
      return i;
    }
    if (option.nargs === 1) {
      let raw: string;
      if (inlineValue !== null) {
        raw = inlineValue;
      } else {
        if (i >= argv.length) {
          const err = new UsageError(
            `Option ${option.paramHint} requires an argument.`,
          );
          err.ctx = ctx;
          throw err;
        }
        raw = argv[i];
        i++;
      }
      bucket.push(
        convertValue(raw, option.type, option.paramHint, option.name),
      );
      return i;
    }
    // nargs > 1
    const values: unknown[] = [];
    if (inlineValue !== null) {
      values.push(
        convertValue(inlineValue, option.type, option.paramHint, option.name),
      );
    }
    while (values.length < option.nargs) {
      if (i >= argv.length) {
        const err = new UsageError(
          `Option ${option.paramHint} requires ${option.nargs} arguments.`,
        );
        err.ctx = ctx;
        throw err;
      }
      values.push(
        convertValue(argv[i], option.type, option.paramHint, option.name),
      );
      i++;
    }
    bucket.push(values);
    return i;
  }
}

const HELP_SENTINEL = Symbol("help");

export interface GroupInit extends CommandInit {
  /** click-default-group: command to run when none is given */
  defaultCommand?: string;
  defaultIfNoArgs?: boolean;
  /** Print "name, version x" for --version */
  version?: string;
  versionName?: string;
}

export class Group extends Command {
  commands = new Map<string, Command>();
  defaultCommand: string | null;
  defaultIfNoArgs: boolean;
  version: string | null;
  versionName: string;

  constructor(init: GroupInit) {
    super(init);
    this.defaultCommand = init.defaultCommand ?? null;
    this.defaultIfNoArgs = init.defaultIfNoArgs ?? false;
    this.version = init.version ?? null;
    this.versionName = init.versionName ?? "cli";
  }

  addCommand(command: Command, name?: string): void {
    this.commands.set(name ?? command.name, command);
  }

  command(init: CommandInit): Command {
    const cmd = new Command(init);
    this.addCommand(cmd);
    return cmd;
  }

  group(init: GroupInit): Group {
    const grp = new Group(init);
    this.addCommand(grp);
    return grp;
  }

  override async invoke(ctx: Context, argv: string[]): Promise<unknown> {
    // Handle --version at the group level
    if (this.version !== null && argv.includes("--version")) {
      echo(`${this.versionName}, version ${this.version}`);
      throw new Exit(0);
    }
    if (argv.includes("--help") && (argv[0] === "--help" || !this.commands.has(argv[0]))) {
      echo(this.getHelp(ctx));
      throw new Exit(0);
    }

    if (!argv.length) {
      if (this.defaultCommand && this.defaultIfNoArgs) {
        const cmd = this.commands.get(this.defaultCommand)!;
        const subCtx = new Context(cmd, ctx, this.defaultCommand);
        return await cmd.invoke(subCtx, argv);
      }
      echo(this.getHelp(ctx));
      throw new Exit(0);
    }

    const first = argv[0];
    if (this.commands.has(first)) {
      const cmd = this.commands.get(first)!;
      const subCtx = new Context(cmd, ctx, first);
      return await cmd.invoke(subCtx, argv.slice(1));
    }

    if (this.defaultCommand) {
      const cmd = this.commands.get(this.defaultCommand)!;
      const subCtx = new Context(cmd, ctx, this.defaultCommand);
      return await cmd.invoke(subCtx, argv);
    }

    const err = new UsageError(`No such command '${first}'.`);
    err.ctx = ctx;
    throw err;
  }
}

// --------------------------------------------------------------- runner

export class Result {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number;
  exception: Error | null;
  returnValue: unknown;

  constructor(init: {
    stdout: string;
    stderr: string;
    output: string;
    exitCode: number;
    exception: Error | null;
    returnValue?: unknown;
  }) {
    this.stdout = init.stdout;
    this.stderr = init.stderr;
    this.output = init.output;
    this.exitCode = init.exitCode;
    this.exception = init.exception;
    this.returnValue = init.returnValue ?? null;
  }

  /** pytest-style alias */
  get exit_code(): number {
    return this.exitCode;
  }
}

class CapturedStreams implements IOStreams {
  stdoutParts: string[] = [];
  stderrParts: string[] = [];
  mixedParts: string[] = [];
  private input: string;
  private inputBuffer: Buffer;
  private pos = 0;
  color: boolean;

  constructor(input: string | Buffer, color: boolean) {
    this.inputBuffer = Buffer.isBuffer(input)
      ? input
      : Buffer.from(input, "utf-8");
    this.input = Buffer.isBuffer(input) ? input.toString("utf-8") : input;
    this.color = color;
  }

  readStdinBuffer(): Buffer {
    const remaining = this.inputBuffer.subarray(this.pos);
    this.pos = this.inputBuffer.length;
    return Buffer.from(remaining);
  }

  writeOut(text: string): void {
    this.stdoutParts.push(text);
    this.mixedParts.push(text);
  }

  writeErr(text: string): void {
    this.stderrParts.push(text);
    this.mixedParts.push(text);
  }

  readStdin(): string {
    return this.readStdinBuffer().toString("utf-8");
  }

  stdinIsTty(): boolean {
    return false;
  }

  readLine(): string | null {
    if (this.pos >= this.inputBuffer.length) return null;
    const idx = this.inputBuffer.indexOf(0x0a, this.pos);
    let line: Buffer;
    if (idx === -1) {
      line = this.inputBuffer.subarray(this.pos);
      this.pos = this.inputBuffer.length;
    } else {
      line = this.inputBuffer.subarray(this.pos, idx);
      this.pos = idx + 1;
    }
    return line.toString("utf-8");
  }
}

export class CliRunner {
  color: boolean;

  constructor({ color = false }: { color?: boolean } = {}) {
    this.color = color;
  }

  async invoke(
    cli: Command,
    args: string[] = [],
    {
      input = null,
      catchExceptions = true,
    }: { input?: string | Buffer | null; catchExceptions?: boolean } = {},
  ): Promise<Result> {
    const captured = new CapturedStreams(input ?? "", this.color);
    const prev = setStreams(captured);
    let exitCode = 0;
    let exception: Error | null = null;
    let returnValue: unknown = null;
    try {
      const ctx = new Context(cli, null, cli.name);
      returnValue = await cli.invoke(ctx, [...args]);
    } catch (e) {
      if (e instanceof Exit) {
        exitCode = e.code;
      } else if (e instanceof ClickException) {
        e.show((s) => captured.writeErr(this.color ? s : stripAnsi(s)));
        exitCode = e.exitCode;
      } else if (e instanceof Abort) {
        captured.writeErr("Aborted!\n");
        exitCode = 1;
      } else {
        if (!catchExceptions) {
          setStreams(prev);
          throw e;
        }
        exception = e as Error;
        exitCode = 1;
      }
    } finally {
      setStreams(prev);
    }
    return new Result({
      stdout: captured.stdoutParts.join(""),
      stderr: captured.stderrParts.join(""),
      output: captured.mixedParts.join(""),
      exitCode,
      exception,
      returnValue,
    });
  }

  /** Run fn inside a fresh temporary working directory. */
  async isolatedFilesystem<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "click-iso-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      return await fn(dir);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Run a CLI as a real process entry point. */
export async function main(cli: Command, argv: string[]): Promise<never> {
  let code = 0;
  try {
    const ctx = new Context(cli, null, cli.name);
    await cli.invoke(ctx, argv);
  } catch (e) {
    if (e instanceof Exit) {
      code = e.code;
    } else if (e instanceof ClickException) {
      e.show((s) => process.stderr.write(s));
      code = e.exitCode;
    } else if (e instanceof Abort) {
      process.stderr.write("Aborted!\n");
      code = 1;
    } else {
      process.stderr.write(String((e as Error).stack ?? e) + "\n");
      code = 1;
    }
  }
  process.exit(code);
}

// Convenience constructors mirroring click's decorators
export function option(
  flags: string[] | string,
  init: Omit<OptionInit, "flags"> = {},
): Option {
  return new Option({
    flags: Array.isArray(flags) ? flags : [flags],
    ...init,
  });
}

export function flag(
  flags: string[] | string,
  init: Omit<OptionInit, "flags" | "isFlag"> = {},
): Option {
  return new Option({
    flags: Array.isArray(flags) ? flags : [flags],
    isFlag: true,
    ...init,
  });
}

export function argument(
  name: string,
  init: Omit<ArgumentInit, "name"> = {},
): Argument {
  return new Argument({ name, ...init });
}
