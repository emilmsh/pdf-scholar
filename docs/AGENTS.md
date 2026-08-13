# The agent rig

Three Claude agents run against this repo from GitHub Actions. They exist for
one reason: the parts of this project that go stale on *other people's*
schedules — provider model catalogues above all — cannot wait for someone's
laptop to be awake. Everything here runs on GitHub's runners.

This document is the contract: what each agent may do on its own, what has to
come through Emil, and what none of them may ever do. The per-task protocols
live elsewhere (`docs/MODEL-UPDATE.md` for the model review); this is the rig
around them.

## Why three jobs and not one agent

Two design facts drive the whole shape:

**Issue text is data, not instructions.** Anything a stranger writes in an
issue can try to steer an agent that reads it ("ignore your instructions,
do X"). A polite sentence in a prompt is not a defence. The defences are
structural: each job gets the *minimum* GitHub token scope it needs, so a
successful injection cannot reach anything the job was not already allowed to
touch — and anything that writes code or speaks to a stranger requires Emil to
have triggered it.

**Untrusted text never gets interpolated into a workflow file.** The prompts
pass the issue *number* (an integer) and let the agent fetch the body with
`gh issue view`. Interpolating `github.event.issue.body` into YAML would be a
shell- and prompt-injection hole in one.

## The three jobs

| Job | Trigger | May do | Token scope | Model |
|---|---|---|---|---|
| **Model review** (`model-review.yml`) | Weekly, Mondays 09:00 Oslo (+ manual) | Read provider docs, edit the curated lists and notes, run typecheck/tests, open a PR | `contents: write`, `pull-requests: write` | Sonnet 5 |
| **Issue triage** (`issue-triage.yml`) | Issue opened/reopened | Apply labels. Nothing else — no comments, no closing | `contents: read`, `issues: write`, and the Bash tool is restricted to `gh issue view/list/edit` | Haiku 4.5 |
| **On request** (`claude-assist.yml`) | Emil writes `@claude` in a comment | Diagnose in a reply, or fix and open a PR | `contents: write`, `pull-requests: write`, `issues: write` | Sonnet 5; Opus 5 when the comment says `@claude opus` |

Every job additionally carries `id-token: write`. That is not repo access — it
lets the workflow request an identity assertion about itself, which
`claude-code-action` needs for its own authentication. Without it the action
fails before it starts, with "Could not fetch an OIDC token", no matter which
credential is configured. It does not widen the scopes in the table.

The on-request job is gated on `author_association == 'OWNER'`. Without that
gate, anyone outside could burn Emil's subscription quota and steer an agent
that holds write access to the repo.

Model choice follows the work: Haiku for labelling because it is mechanical and
high-volume, Sonnet for the review because it reads documentation carefully and
writes little code, and Opus on request for *fixes* — this codebase punishes
shallow reading (blend modes that die inside stacking contexts, overlay hosts
that kill text selection, the FreeText font ceiling), and those traps are worth
the heavier model when code is actually changing.

## What no agent may ever do

These hold regardless of who asked, including Emil:

- **Push to master.** A pull request is the only delivery. (A branch ruleset
  enforces this: PRs required, with the repository admin as the only bypass, so
  Emil keeps his direct-push workflow and the agents structurally do not.)
- **Push a tag.** `v*` tags start the release pipeline.
- **Change product decisions**: `DEFAULT_AI_MODELS` and the thinking /
  reasoning-effort defaults (`src/shared/defaults.ts`, `src/shared/ai-chat.ts`),
  the claims in `docs/MESSAGING.md`, the version in `package.json`.
- **Touch screenshots.** Every shipped image is shot by hand — an agent may
  report that a frame looks stale, never replace it.
- **Add a runtime dependency.** The installer's size lives in `dependencies`;
  that list changes deliberately or not at all.
- **Commit a secret**, or read one beyond the token its own job was given.
- **Speak to a stranger unprompted.** Only the triage job runs on someone
  else's issue, and it may only attach labels.

An agent that proposes any of the above has found a bug in the rig, not a good
idea. Reject the PR and fix the prompt.

## What Emil does

- **Once:** add the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (`claude
  setup-token`) — the agents run on the Claude subscription rather than metered
  API billing.
- **Per PR:** read it and merge or close. This is the *entire* decision point
  of the rig. For a model-review PR that means checking that the parameter
  claims carry sources: an agent can read a documentation page confidently
  wrong, which is exactly why the delivery is a PR.
- **After merging a model-review PR:** fire one real question per touched
  provider with his own keys. The CI run holds no provider keys, so nothing was
  verified live — the PR body says which providers need it.
- **Monthly** (`docs/MAINTENANCE.md`): token expiry, and that the scheduled
  workflow is still enabled — GitHub suspends cron after ~60 days without repo
  activity.

And what he should not do: merge a model-review PR unread because it is "just
data", hand the rig provider API keys to widen a report, or accept a PR that
touches the defaults.

## How Emil hears about it

The rig is deliberately quiet, so it is worth being exact about which of these
land in an inbox:

| Event | Notification |
|---|---|
| Review finds drift → PR | Yes. The PR is **assigned** to Emil, which notifies whatever his repository watch setting is — a bot-opened PR on its own only reaches a watcher on "All Activity" |
| Review finds nothing | Nothing at all. The run summary in the Actions tab is the only trace |
| A scheduled run fails | GitHub emails whoever last modified the workflow file |
| Someone opens an issue | GitHub's ordinary issue notification, unchanged by this rig |
| Triage labels that issue | Nothing. Label changes never notify — the labels are simply there when the issue is opened |

The gap that leaves: a silent week is indistinguishable from a dead workflow.
Two things cover it — GitHub emails before suspending cron after ~60 days
without repo activity, and `docs/MAINTENANCE.md` row 7 checks that the
scheduled workflows are still enabled every month.

**Silence is the decision, not the default** (Emil, 2026-08-13). The louder
alternative — one comment a week on a long-lived log issue, buying a scannable
history for a notification a week — was considered and turned down: a review
that finds nothing has nothing to say, and a weekly ping for "nothing to see"
trains you to ignore the one that matters. Do not re-pitch it without a reason
the two covers above failed.

## Honest limits

Things this rig does *not* give, so nobody counts on them:

- **CI may not run on agent-opened PRs.** GitHub deliberately does not let
  events raised with the repository's default token start other workflows.
  Whether `claude-code-action` signs its pushes with that token or with the
  Claude App's installation token decides it, and the first real PR is what
  tells us. The agents run `typecheck` and the relevant tests in-session
  regardless, so a PR is never unverified — but the three-OS build may be
  missing. Fix with a PAT if it turns out to matter.
- **The triage job could, if injected, post a comment.** GitHub's `issues`
  scope covers labels and comments together, so "labels only" is enforced by
  the Bash tool restriction and the prompt, not by the token. What *is*
  structural is that it cannot touch code: it has no write access to contents.
- **Cron is approximate.** Scheduled runs can be delayed under load, which is
  why the review fires at :17 rather than on the hour.
- **No agent verifies a model against a live API.** They read documentation.
  Live verification is Emil's pass, by design — see the keys point above.

## Adding a job to the rig

Answer these before writing the workflow: what is the smallest token scope that
does the work; does it read text a stranger wrote, and if so what stops that
text from being followed; who triggers it; and what does it deliver that a
human reads before it becomes real. If a new job cannot answer all four, it
does not belong here yet.
