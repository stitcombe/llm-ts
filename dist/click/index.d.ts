/**
 * Mini-click: a TypeScript stand-in for the parts of Python's click that
 * llm's CLI uses — command groups (with click-default-group behavior),
 * option/argument parsing, help output, ClickException handling, echo
 * with ANSI stripping, and a CliRunner test harness that captures
 * stdout/stderr/mixed output like click 8.2+.
 *
 * Command handlers are async functions receiving (params, ctx).
 */
export declare class ClickException extends Error {
    exitCode: number;
    constructor(message: string);
    formatMessage(): string;
    show(write: (s: string) => void): void;
}
export declare class UsageError extends ClickException {
    exitCode: number;
    ctx: Context | null;
    show(write: (s: string) => void): void;
}
export declare class BadParameter extends UsageError {
    paramHint: string | null;
    constructor(message: string, paramHint?: string | null);
    formatMessage(): string;
}
export declare class NoSuchOption extends UsageError {
    constructor(optionName: string);
}
export declare class Abort extends Error {
    constructor();
}
export declare class Exit extends Error {
    code: number;
    constructor(code?: number);
}
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
export declare function setStreams(streams: IOStreams): IOStreams;
export declare function getStreams(): IOStreams;
export declare function stripAnsi(text: string): string;
export declare function echo(message?: unknown, { nl, err, color, }?: {
    nl?: boolean;
    err?: boolean;
    color?: boolean | null;
}): void;
export declare function style(text: string, { fg, bold, dim, underline, italic, reset, }?: {
    fg?: string | null;
    bold?: boolean;
    dim?: boolean;
    underline?: boolean;
    italic?: boolean;
    reset?: boolean;
}): string;
export declare function prompt(text: string, { default: defaultValue, hideInput, }?: {
    default?: string | null;
    hideInput?: boolean;
}): string;
export declare function confirm(text: string): boolean;
/** click.edit stand-in — no interactive editor in this environment. */
export declare function edit(_text?: string): string | null;
export type ParamTypeName = "string" | "int" | "float" | "bool";
export declare class Choice {
    choices: string[];
    constructor(choices: Iterable<string>);
}
export declare class Path {
    exists: boolean;
    allowDash: boolean;
    dirOkay: boolean;
    fileOkay: boolean;
    writable: boolean;
    readable: boolean;
    constructor({ exists, allowDash, dirOkay, fileOkay, writable, readable, }?: {
        exists?: boolean;
        allowDash?: boolean;
        dirOkay?: boolean;
        fileOkay?: boolean;
        writable?: boolean;
        readable?: boolean;
    });
}
export declare class File {
    mode: string;
    constructor(mode?: string);
}
export type ParamType = ParamTypeName | Choice | Path | File;
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
export declare class Option {
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
    constructor(init: OptionInit);
    get paramHint(): string;
}
export interface ArgumentInit {
    name: string;
    type?: ParamType;
    required?: boolean;
    nargs?: number;
    default?: unknown;
    callback?: (ctx: Context, param: Argument, value: unknown) => unknown;
}
export declare class Argument {
    name: string;
    type: ParamType;
    required: boolean;
    nargs: number;
    default: unknown;
    callback: ((ctx: Context, param: Argument, value: unknown) => unknown) | null;
    constructor(init: ArgumentInit);
    get paramHint(): string;
}
export declare class Context {
    command: Command;
    parent: Context | null;
    params: Record<string, unknown>;
    obj: unknown;
    infoName: string;
    constructor(command: Command, parent?: Context | null, infoName?: string);
    get commandPath(): string;
    exit(code?: number): never;
    getUsage(): string;
    getHelp(): string;
}
export type Handler = (params: Record<string, any>, ctx: Context) => unknown | Promise<unknown>;
export interface CommandInit {
    name: string;
    help?: string;
    shortHelp?: string;
    options?: Option[];
    arguments?: Argument[];
    handler?: Handler;
    hidden?: boolean;
}
export declare class Command {
    name: string;
    help: string;
    shortHelp: string;
    options: Option[];
    args: Argument[];
    handler: Handler | null;
    hidden: boolean;
    constructor(init: CommandInit);
    getUsage(ctx: Context): string;
    getHelp(ctx: Context): string;
    /** Parse args and run. Throws Exit / ClickException. */
    invoke(ctx: Context, argv: string[]): Promise<unknown>;
    protected parseArgs(ctx: Context, argv: string[]): Record<string, unknown> | typeof HELP_SENTINEL;
    private consumeOption;
}
declare const HELP_SENTINEL: unique symbol;
export interface GroupInit extends CommandInit {
    /** click-default-group: command to run when none is given */
    defaultCommand?: string;
    defaultIfNoArgs?: boolean;
    /** Print "name, version x" for --version */
    version?: string;
    versionName?: string;
}
export declare class Group extends Command {
    commands: Map<string, Command>;
    defaultCommand: string | null;
    defaultIfNoArgs: boolean;
    version: string | null;
    versionName: string;
    constructor(init: GroupInit);
    addCommand(command: Command, name?: string): void;
    command(init: CommandInit): Command;
    group(init: GroupInit): Group;
    invoke(ctx: Context, argv: string[]): Promise<unknown>;
}
export declare class Result {
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
    });
    /** pytest-style alias */
    get exit_code(): number;
}
export declare class CliRunner {
    color: boolean;
    constructor({ color }?: {
        color?: boolean;
    });
    invoke(cli: Command, args?: string[], { input, catchExceptions, }?: {
        input?: string | Buffer | null;
        catchExceptions?: boolean;
    }): Promise<Result>;
    /** Run fn inside a fresh temporary working directory. */
    isolatedFilesystem<T>(fn: (dir: string) => Promise<T> | T): Promise<T>;
}
/** Run a CLI as a real process entry point. */
export declare function main(cli: Command, argv: string[]): Promise<never>;
export declare function option(flags: string[] | string, init?: Omit<OptionInit, "flags">): Option;
export declare function flag(flags: string[] | string, init?: Omit<OptionInit, "flags" | "isFlag">): Option;
export declare function argument(name: string, init?: Omit<ArgumentInit, "name">): Argument;
export {};
