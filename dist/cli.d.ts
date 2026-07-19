/**
 * Port of llm/cli.py — the llm command-line interface, built on the
 * mini-click layer in src/click/index.ts.
 *
 * Deviations from Python are documented in PORTING_NOTES.md; notably
 * --functions accepts JavaScript source (not Python), and
 * install/uninstall are not supported (npm handles plugins).
 */
import * as click from "./click/index.js";
import { CliRunner } from "./click/index.js";
import { Attachment, _BaseConversation } from "./models.js";
import { Template } from "./templates.js";
import { Database } from "./sqliteUtils.js";
import { Fragment } from "./utils.js";
import type { StreamEvent } from "./parts.js";
export declare class FragmentNotFound extends Error {
}
export declare class LoadTemplateError extends Error {
}
export declare function displayStreamEvents(events: AsyncIterable<StreamEvent> | Iterable<StreamEvent>, { showReasoning }?: {
    showReasoning?: boolean;
}): Promise<void>;
export declare function resolveFragments(db: Database, fragments: Iterable<string>, allowAttachments?: boolean): Promise<Array<Fragment | Attachment>>;
export declare function resolveAttachment(value: string): Promise<Attachment>;
export declare function templateDir(): string;
export declare function logsDbPath(): string;
export declare function logsOn(): boolean;
export declare function getAllModelOptions(): Record<string, Record<string, unknown>>;
export declare function getModelOptions(modelId: string): Record<string, unknown>;
export declare function setModelOption(modelId: string, key: string, value: unknown): void;
export declare function clearModelOption(modelId: string, key: string): void;
export declare function loadTemplate(name: string): Promise<Template>;
export declare function loadConversation(conversationId: string | null, async_?: boolean, database?: string | null): Promise<_BaseConversation | null>;
export declare const cli: click.Group;
export { CliRunner };
