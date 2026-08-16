# Testing the AI path

The AI feature is the only part of the app whose correctness depends on
machines we do not control, answering in formats they change without telling
anyone. Every AI bug that has actually reached a user came from a stream nobody
had imagined — not from logic we got wrong. This document is the strategy that
follows from that, and the honest account of what each layer can and cannot
catch.

## The four layers

| Layer | Command | Needs | Runs | Catches |
|---|---|---|---|---|
| 1. Unit / shaping | `npm run test:ai-chat` | nothing | CI, every push | What we SEND (params per provider, quote contract, images, tools), how we parse streams we imagined, the degrade-on-400 nets, and that every path matches its `PROVIDER_PROFILES` row |
| 2. Recorded streams | `npm run test:streams` | nothing | CI, every push | What providers ACTUALLY sent, replayed byte for byte with their own write boundaries |
| 3. Live conformance | `npm run test:live` | API keys | by hand: release + monthly | Everything the other three cannot: that the models we offer today still answer, cite, see images, and do not trip the degrade net |
| 4. Real UI | `npm run test:ai-settings`, `test:assistant` | built app, desktop session | by hand before a release | That the answer reaches the panel — settings flow, model menu, streaming, citation chips, the detached window |

Layers 1 and 2 differ in a way worth stating plainly: **a mock is written from
the same assumptions as the code it tests.** If we did not know a provider
streams its reasoning in `delta.reasoning`, we would not mock a stream that
does. Layer 2 exists because a recording cannot flatter our assumptions.

## Layer 3 — the live run

```bash
npm run test:live                      # every provider with a key in env
npm run test:live -- --self-check      # no keys: the harness against a local fake endpoint
npm run test:live -- --record          # …and save each stream into the replay library
npm run test:live -- --provider=openrouter --model=moonshotai/kimi-k2.5
```

Keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`,
`GROQ_API_KEY`); providers without one are skipped and said so. Every curated
model at every keyed provider is asked one short question about a three-page
test document, and then shown one 2×2 red PNG. Per model it asserts:

- **it answers**, inside the deadline (`--deadline=<ms>`, default 120 s);
- **a citation survived** into the answer — the panel's whole point is a claim
  you can jump into the PDF from, and the quote contract is fragile in exactly
  the way that fails silently;
- **the answer used the document** (the test document contains one number);
- **an image is read, or refused BY NAME** — `ai-model-no-images` and nothing
  else. A raw 400, silence, or a confident answer about a picture the model
  never saw are all failures;
- **something arrived before the deadline**, so the panel is never sitting on
  «Leser dokumentet …» with nothing behind it;
- **the degrade net did not fire.** One question that costs two HTTP requests
  means a parameter we send was refused and silently dropped: the user still
  gets an answer, but a worse one, and this is the only place that shows up.

It is not in CI on purpose: it needs keys, it spends tokens, and a provider
outage is not a broken build. Cost is a few øre per full run.

## Layer 2 — the replay library

`scripts/fixtures/streams/*.json` holds recorded streams: provider, model, the
HTTP status, and the response **as a list of chunks in the writes they arrived
in**. That last detail is the point — re-joining them into one body would stop
testing the buffering, and a frame the provider cut down the middle of a JSON
object is precisely the shape worth keeping.

Each fixture's `expect` block is what the parser produced *the day the bytes
were real*. It is a description, not an ideal: its job is to fail when a future
change to the parser silently alters the outcome for a stream that actually
happened.

The committed set comes from the local fake endpoint
(`scripts/lib/fake-provider.mjs`), which exists to aim shapes at the parser that
no real provider can be asked to produce on demand:

| Scenario | The failure it guards |
|---|---|
| `answer` | the everyday path |
| `reasoning` | thinking deltas reach the panel as liveness, never as answer text |
| `reasoning-only` | a stream that thinks and then ends is a NAMED failure, not an empty success |
| `upstream-error` | an error event inside an HTTP 200 is surfaced, not swallowed |
| `split-json` | a JSON frame cut across two TCP writes still parses |
| `keepalive` | `: ping` comments and blank lines between frames |
| `truncated` | a body that stops mid-answer keeps the partial answer |
| `non-streaming` | a server that ignores `stream: true` and sends one JSON body |

Those eight are the Kimi K2.5 incident of 2026-08-16 turned into permanent
tests: the model streamed minutes of `reasoning` nothing read, and the app sat
on «Leser dokumentet …» forever. Three separate bugs, all invisible to layer 1.

**Adding a real recording is one paid run.** `npm run test:live -- --record`
against a provider, and the stream is guarded keylessly from then on. Record
whenever you touch a new provider, a new model family, or reproduce a live bug
— a reproduced bug that gets recorded can never come back unnoticed.

## When to run what

- **Every push:** layers 1 and 2, automatically (`.github/workflows/ci.yml`).
- **Before a release** (`docs/RELEASE.md`): layer 3, then layer 4.
- **Monthly** (`docs/MAINTENANCE.md` row 1): layer 3, alongside
  `npm run check:models` — that pass is about the catalogue going stale, and
  this is how you find out whether the models in it still behave.
- **After any change to `src/shared/ai-chat.ts`:** layers 1 and 2 at minimum.
  If the change touches request shaping, layer 3 for the affected provider —
  the degrade-net assertion is the one that tells you a parameter is wrong.

## What none of this covers

Worth writing down so nobody mistakes a green run for a guarantee:

- **Long documents.** The excerpt path (`test:retrieval`) is tested on its own,
  but no live test attaches a 300-page document and checks the answer is still
  grounded. Cost, mostly.
- **Multi-turn drift.** Every live case is a single question. Context handling
  across ten turns with images in earlier turns is untested.
- **Answer quality.** We test that a citation parses, not that it is the right
  passage. That judgement stays Emil's.
- **Rate limits and outages.** The named codes exist (`ai-rate-limited`,
  `ai-endpoint-unreachable`) and layer 1 covers their parsing, but nothing
  provokes them live.
