# Porting notes: llm (Python) → llm-ts (TypeScript)

Port of [simonw/llm](https://github.com/simonw/llm) 0.32a3 (the fork at
`/Users/stitcombe/git/gh_loon-labs/llm`, which adds parts.py and
pause/resume) and its complete unit test suite to TypeScript under
[vitest](https://vitest.dev). Uses `pluggy-ts` for the plugin system.

This port was completed by Claude Fable 5, based on
[simonw/llm](https://github.com/simonw/llm) commit
[`0392226e6630746ef51ffd309c2bee6a5f72b58e`](https://github.com/simonw/llm/commit/0392226e6630746ef51ffd309c2bee6a5f72b58e)
(`0.32a3`), plus its [llm-anthropic](https://github.com/simonw/llm-anthropic)
plugin at commit
[`3ae428f3b5143cc81da25af0271d8fa55bda3f05`](https://github.com/simonw/llm-anthropic/commit/3ae428f3b5143cc81da25af0271d8fa55bda3f05)
and [llm-openrouter](https://github.com/simonw/llm-openrouter) plugin at
commit
[`bcda46afe7449df3455254f4390f8618d711aaf5`](https://github.com/simonw/llm-openrouter/commit/bcda46afe7449df3455254f4390f8618d711aaf5)
(`0.6`).

## Status / progress log

- [x] Project scaffold (package.json, tsconfig, vitest.config.ts)
- [x] src/errors.ts (errors.py)
- [x] src/hookspecs.ts (hookspecs.py)
- [x] src/plugins.ts (plugins.py)
- [x] src/tools.ts (tools.py)
- [x] src/default_plugins/default_tools.ts
- [x] src/utils.ts (utils.py) — logging_client deferred to openai client
- [x] src/pyjson.ts (Python-compatible json.dumps; NEW module)
- [x] src/ulid.ts (python-ulid subset; NEW module)
- [x] src/pydantic.ts (mini-pydantic: BaseModel/fields/validators; NEW)
- [x] src/introspect.ts (inspect.signature stand-in; NEW)
- [x] src/config.ts (user_dir/keys/default model half of __init__.py)
- [x] src/serialization.ts (serialization.py)
- [x] src/parts.ts (parts.py)
- [x] src/models.ts (models.py)
- [x] src/condense.ts (condense-json dep) — identity for now, see below
- [x] src/dbutils.ts (ensure_fragment/ensure_tool from utils.py)
- [x] src/sqliteUtils.ts (sqlite-utils subset over better-sqlite3; NEW)
- [x] src/migrations.ts (migrations.py + sqlite-migrate)
- [x] src/embeddings.ts, src/embeddingsMigrations.ts
- [x] src/templates.ts (templates.py)
- [x] src/default_plugins/openai_models.ts (fetch-based OpenAI client)
- [x] src/click/ (mini-click: commands, options, CliRunner test harness)
- [x] src/cli.ts (cli.py)
- [x] src/index.ts (rest of __init__.py: model registry, aliases)
- [x] src/bin.ts (NEW — `llm` executable entry point; hands `process.argv`
  to `src/click`'s `main()` against `cli.ts`'s `cli` `Group`. Python has no
  analog since `pip install` generates the console-script wrapper from
  `pyproject.toml`'s `[project.scripts]`; `npm run build` chmods
  `dist/bin.js` executable to stand in for that.)
- [x] test/ — ALL 28 tests/test_*.py files ported; suite: 787 passing,
  0 skipped, 0 todo (conftest fixtures → test/conftest.ts)
  - test_serialization: runtime DictSpecs + validators added to
    src/serialization.ts to stand in for TypedDict introspection /
    pydantic TypeAdapter; the six *_to_dict_annotation tests are
    tsc-enforced (return types checked at compile time, not runtime)
  - test_parts: added to parts.ts: strict unknown-key TypeError in Part
    constructors, empty provider_metadata omitted like Python falsy
    check, helpers accept trailing {provider_metadata} options object
  - test_utils: Python's `test_test_truncate_string_keep_end` (typo'd
    name) is `test_truncate_string_keep_end` here
  - test_openai_messages / test_openai_responses / test_tools /
    test_tools_streaming: @pytest.mark.vcr tests replay the recorded
    Python cassettes (copied to test/cassettes/) via test/cassettes.ts
    (yaml + gunzip + SSE splitting into the FetchMock)
  - Chat/AsyncChat grew a public `build_messages(prompt, conversation)`
    and Responses/AsyncResponses `_build_responses_input` /
    `_build_responses_kwargs` methods mirroring the Python API surface
    that tests poke directly

## Plugins: llm-anthropic and llm-openrouter

Ports of the two sibling plugin repos, brought into this repo under
`src/plugins/`. Both are **opt-in** rather than default plugins: in
Python they are separate pip packages discovered via entry points, and
adding them to `DEFAULT_PLUGINS` would change `llm plugins` / `llm models
list` output for every core test. Register them explicitly
(`pm.register(anthropicPlugin, "llm_anthropic")`) or via
`LLM_LOAD_PLUGINS`.

- [x] `src/anthropicClient.ts` (fetch-based stand-in for the `anthropic`
  SDK: messages.create + messages.stream with SSE accumulation)
- [x] `src/plugins/anthropic.ts` (llm_anthropic.py)
- [x] `src/plugins/openrouter.ts` (llm_openrouter.py)
- [x] `test/test_anthropic.test.ts` — all 30 Python tests ported (35 in
  TS after splitting parametrized cases); cassettes copied to
  `test/cassettes/test_anthropic/`
- [x] `test/test_llm_openrouter.test.ts` — all 4 Python tests ported;
  cassettes copied to `test/cassettes/test_llm_openrouter/`

### Anthropic notes

- `anthropic.transform_schema` is reimplemented as `transformSchema()`:
  it recursively stamps `additionalProperties: false` onto every object
  schema, matching the recorded request bodies.
- The SDK's `Message.model_dump()` emits pydantic defaults the wire
  format omits. `normalizeMessage()` fills in the ones the tests
  observe: `container` / `stop_details` on the message, `citations` /
  `parsed_output` on text blocks.
- `betas` and `extra_body` kwargs are handled the way the Python SDK
  handles them: `betas` becomes the `anthropic-beta` header, `extra_body`
  is merged into the request body.
- Attachments: `build_messages` must stay synchronous (tests call it
  directly), but base64/type resolution is async in TS. `execute()`
  therefore runs `prepareAttachments()` first, caching `attachment.type`
  and a `_base64` payload that `sourceForAttachment` then reads
  synchronously.
- **`thinking_effort='max'` validation is new.** The upstream Python
  test `test_46_max_effort_opus_only` asserts a ValueError that
  `llm_anthropic.py` never raises — the check is missing from the plugin
  source. It is implemented here in `buildKwargs` (max effort is
  rejected for non-Opus models) so the ported test passes. Worth
  confirming against upstream intent.
- `@model_validator(mode="after")` had no equivalent in
  `src/pydantic.ts`; a `static modelValidators: ModelValidator[]` hook
  was added to `BaseModel` for `validate_temperature_top_p` and
  `validate_web_search_domains_conflict`.

### OpenRouter notes

- `fetch_cached_json` used a blocking `httpx.get` inside
  `register_models`. JS has no synchronous HTTP, so the download is split
  into async `ensureModelsCached()` (refreshes the on-disk cache) and
  sync `getOpenrouterModels()` (reads it). Anything that consults the
  model registry must await `ensureModelsCached()` first.
- The Python SDK's `extra_body` kwarg is merged straight into the request
  body, since the TS OpenAI client spreads kwargs onto the body — the
  wire format is identical.
- `Chat` / `AsyncChat` gained a public `build_kwargs(prompt, stream)`
  method (previously a module-private function) so the OpenRouter
  subclasses can override it the way the Python `_mixin` does.
- The upstream Python tests do not cover the `online` / `provider` /
  `reasoning_*` options at all; that coverage gap is inherited here.

## Module mapping

| Python | TypeScript |
| --- | --- |
| `llm/__init__.py` | `src/index.ts` + `src/config.ts` |
| `llm/models.py` | `src/models.ts` |
| `llm/parts.py` | `src/parts.ts` |
| `llm/serialization.py` | `src/serialization.ts` |
| `llm/utils.py` | `src/utils.ts` (+ `src/dbutils.ts` for db helpers) |
| `llm/plugins.py` | `src/plugins.ts` |
| `llm/hookspecs.py` | `src/hookspecs.ts` |
| `llm/errors.py` | `src/errors.ts` |
| `llm/tools.py` | `src/tools.ts` |
| `llm/templates.py` | `src/templates.ts` |
| `llm/migrations.py` | `src/migrations.ts` |
| `llm/embeddings.py` | `src/embeddings.ts` |
| `llm/embeddings_migrations.py` | `src/embeddingsMigrations.ts` |
| `llm/cli.py` | `src/cli.ts` |
| `llm/default_plugins/*` | `src/default_plugins/*` |
| pydantic | `src/pydantic.ts` (mini implementation) |
| click | `src/click/` (mini implementation + CliRunner) |
| sqlite-utils | `src/sqliteUtils.ts` over better-sqlite3 |
| python-ulid | `src/ulid.ts` |
| condense-json | `src/condense.ts` |
| puremagic | magic-byte sniffing in `src/utils.ts` |
| openai client | fetch-based client in `src/default_plugins/openai_models.ts` |
| `llm_anthropic.py` | `src/plugins/anthropic.ts` |
| `llm_openrouter.py` | `src/plugins/openrouter.ts` |
| anthropic client | fetch-based client in `src/anthropicClient.ts` |

## Dependency choices

- `pluggy-ts` via `file:../pluggy-ts`. Hookspecs/impls use plain named
  parameters; hook calls pass a kwargs object (pluggy-ts convention).
- `better-sqlite3` for SQLite (sync API matches sqlite-utils usage).
- `@noble/hashes` for blake2b (make_schema_id, digest_size=16).
- `js-yaml` for templates + cassette loading.
- vitest, pool: forks (tests mutate env vars/cwd).

## Deliberate API deviations (Python → TS)

- **Kwargs**: Python keyword arguments become a single trailing options
  object: `model.prompt("hi", system="x")` → `model.prompt("hi", {system:
  "x"})`. Extra model options (e.g. `max_tokens=4`) ride in the same
  object and are split out by key (any key that is not a known prompt
  kwarg is treated as a model option).
- **Sync→async**: JS cannot block on promises, so these Python-sync APIs
  are async in TS: `execute_tool_calls`, `reply`, `log_to_db` (network
  for attachment types), everything on Chain responses
  (`ChainResponse.responses()` is an async generator; `.text()` async),
  `EmbeddingModel.embed/embed_multi/embed_batch`, `Collection` methods,
  `Response.from_dict` / `from_row` (dynamic import of the registry).
  Sync `Response` iteration/`text()` stays sync (works for sync model
  plugins like the test mocks).
- **Attachment.resolve_type**: async (`resolveType()`); the sync checks
  Python performed eagerly still happen at prompt() time via
  `validateAttachmentsSync` except URL HEAD resolution, which happens at
  execution/log time.
- **Tool.function**: runtime type annotations don't exist in TS. Types
  come from an optional `fn.annotations = {param: "integer" | schema}`
  map (default "string"); descriptions from `fn.description`. Parameter
  names/defaults are parsed from `Function.prototype.toString()`
  (same approach as pluggy-ts `varnames`).
- **Toolbox**: `__init_subclass__` config capture is replaced by the
  convention that Toolbox constructors take a single options object which
  the base constructor stores as `_config`.
- **Options (pydantic)**: `class Options(llm.Options)` with annotated
  fields becomes a subclass with a `static fields: {name: FieldDef}`
  map. Validation errors are `ValidationError` with an `errors()` list
  (loc/msg/type mirroring pydantic v2 messages).
- **instantiate_from_spec**: Python's `Class({"a": 1})` unpacks as
  **kwargs; TS passes the parsed object as the single constructor arg.
- **json.dumps parity**: `src/pyjson.ts` `dumps()` mirrors Python's
  separators, indent style and ensure_ascii. Whole floats are the one
  unavoidable difference (`1.0` → `"1"`).
- **datetime_utc**: ISO strings use `+00:00` suffix like Python
  isoformat; milliseconds precision (Python has microseconds).
- **condense-json**: `src/condense.ts` is currently an identity
  passthrough — no test asserts condensed structures; replace with a
  real port if that changes.
- **LLM_LOAD_PLUGINS**: entrypoint loading is `loadEntrypointPlugins()`
  (async, dynamic import of npm package names); the sync
  `loadPlugins()` registers only the default plugins. Tests set
  `testState.calledFromTest` (the `sys._called_from_test` analog).
- **monotonic_ulid**: no threading in Node; the lock is unnecessary.

## Test suite mapping

`tests/test_*.py` → `test/test_*.test.ts`, `tests/conftest.py` →
`test/conftest.ts`. pytest-httpx / vcr cassettes are replaced by a fetch
mock; details recorded here as they are ported.
