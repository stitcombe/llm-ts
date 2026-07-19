# llm-ts

A TypeScript port of [llm](https://github.com/simonw/llm), Simon Willison's
CLI tool and Python library for interacting with large language models —
running one-off prompts, chatting, storing prompts/responses in SQLite,
generating embeddings, calling tools, and more, across many providers
through a common plugin system.

This port covers the full `llm` core library plus two of its provider
plugins, [`llm-anthropic`](https://github.com/simonw/llm-anthropic) and
[`llm-openrouter`](https://github.com/simonw/llm-openrouter), and ships
[`pluggy-ts`](https://github.com/loon-labs/pluggy-ts) (a matching TS port of
`pluggy`) as its plugin system. The complete upstream unit test suites have
been ported alongside the library — 826 tests passing across 32 files. See
[`PORTING_NOTES.md`](PORTING_NOTES.md) for the exact commits ported, the
full module mapping, and every deliberate deviation from the Python
originals.

## Status

- The core library (`src/index.ts`) is complete and fully tested — model
  registry, prompting, conversations, tools, templates, fragments,
  embeddings/collections, and the SQLite logs database all work.
- The full Click-equivalent command tree (`llm prompt`, `llm chat`, `llm
  logs`, `llm keys`, `llm models`, `llm embed`, `llm templates`, `llm
  schemas`, `llm tools`, ...) is ported in `src/cli.ts`, exercised
  end-to-end by the ported CLI test suite via an in-process `CliRunner`,
  and wired up as a real `llm` binary via `src/bin.ts` (built to
  `dist/bin.js`, the `bin` entry in `package.json`) — see [CLI](#cli).
- `llm-anthropic` and `llm-openrouter` are opt-in plugins (see
  [Plugins](#plugins) below), matching how they ship as separate pip
  packages upstream.

## Installation

The package ships compiled ESM JavaScript plus type declarations in `dist/`,
which is not checked in and must be built first. It requires Node 18+.

```sh
git clone https://github.com/stitcombe/llm-ts.git
cd llm-ts && npm install && npm run build && npm pack

# in your project
npm install /path/to/llm-ts/llm-ts-0.32.0-alpha.3.tgz
```

or reference the checkout directly (build it first — there's no
`prepack`/`prepare` hook to do it for you):

```sh
cd llm-ts && npm install && npm run build
npm install /path/to/llm-ts
```

Then import it like any package:

```ts
import { getModel } from "llm-ts";
```

Notes for consumers:

- **ESM only.** Your project should have `"type": "module"` (or import it
  from an `.mts` file / a bundler). There is no CommonJS build.
- `package.json` only exports the package root (`.`); the plugin modules
  (`src/plugins/anthropic.ts`, `src/plugins/openrouter.ts`) aren't exposed
  as subpath exports yet, so registering them today means working inside
  this repo (see [Plugins](#plugins)) rather than importing them from an
  installed dependency.

## A basic example

```ts
import { getModel } from "llm-ts";

const model = getModel("gpt-4o-mini"); // needs OPENAI_API_KEY, or llm.setKey()
const response = model.prompt("Five names for a pet pelican");
console.log(response.text());
```

Async models (most provider plugins) look the same but `.text()` returns a
promise:

```ts
import { getAsyncModel } from "llm-ts";

const model = getAsyncModel("gpt-4o-mini");
const response = model.prompt("Five names for a pet pelican");
console.log(await response.text());
```

Conversations, tool calls, schemas, fragments, and templates all mirror the
Python API — see `test/test_llm.test.ts` and `PORTING_NOTES.md`'s
"Deliberate API deviations" section for the JS-specific conventions (kwargs
become a single trailing options object, `Response`/`Chain` methods that do
network I/O are async, etc).

## CLI

```sh
npm run build
./dist/bin.js --version
./dist/bin.js 'Five outrageous names for a pet pelican'
./dist/bin.js models list
./dist/bin.js keys set openai
```

Once installed as a dependency (or globally, via `npm install -g`), the
`llm` binary from `package.json`'s `bin` field runs the same command tree.
`npm run build` chmods `dist/bin.js` executable as part of the build; the
source (`src/bin.ts`) is a 4-line entry point that hands `process.argv` to
`src/click`'s `main()` against the `cli` `Group` exported by `src/cli.ts` —
the same command tree the CLI test suite drives in-process via `CliRunner`.

## Plugins

`llm-anthropic` and `llm-openrouter` are registered explicitly rather than
loaded by default, since in Python they're separate pip packages discovered
via entry points:

```ts
import { pm } from "llm-ts";
import * as anthropic from "../src/plugins/anthropic.js"; // relative to this repo
import * as openrouter from "../src/plugins/openrouter.js";

pm.register(anthropic, "llm_anthropic");   // needs ANTHROPIC_API_KEY
pm.register(openrouter, "llm_openrouter"); // needs OPENROUTER_KEY
```

Since `package.json`'s `exports` map only lists `.`, `llm-ts/src/plugins/...`
doesn't resolve from outside (or even from within, via self-reference) —
the relative path above only works from inside a checkout of this repo.
Consuming the plugins from an installed `llm-ts` dependency will need a
`./plugins/anthropic` / `./plugins/openrouter` subpath export added to
`package.json` first.

## Development

```sh
npm install
npm test          # vitest run — the ported llm/llm-anthropic/llm-openrouter test suites
npm run typecheck # tsc --noEmit over src + test
npm run build     # emit dist/ (ESM + .d.ts)
```

## Layout

- `src/` — the library, one module per Python source module (see the
  mapping table in `PORTING_NOTES.md`).
- `src/bin.ts` — the `llm` executable entry point (`dist/bin.js`).
- `src/plugins/` — the `llm-anthropic` and `llm-openrouter` ports.
- `src/click/` — a minimal Click stand-in (commands, options, `CliRunner`)
  used by `src/cli.ts` and its tests.
- `test/` — the ported unit test suites, one file per `tests/test_*.py`.
- `dist/` — build output (generated, gitignored).
- `PORTING_NOTES.md` — module mapping, API conventions, and every
  deliberate deviation from the Python originals.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE). llm-ts is a port of
[llm](https://github.com/simonw/llm), [llm-anthropic](https://github.com/simonw/llm-anthropic),
and [llm-openrouter](https://github.com/simonw/llm-openrouter), all by Simon
Willison and Apache-2.0 licensed.
