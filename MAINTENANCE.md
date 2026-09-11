# Instructions for the hourly maintenance agent

An hourly cloud routine runs an agent against this repository. It starts with **no memory of any
previous run** — this file, `ROADMAP.md` and `README.md` are everything it knows. If you are that
agent, this file is your brief. If you are a human changing how the agent behaves, change it here
rather than in the routine, so the reasoning stays next to the code.

SafeWalk is live and used by real people walking home at night. **A confident wrong claim about a
street is worse than a missing feature.** Everything below follows from that.

## Before you pick anything: find out what already exists

You have no memory of previous runs, and previous runs were you. On 2026-09-08 that produced eleven
pull requests in eleven hours, five of them the same police-layer fix and three of them the same
forgot-password flow, because every run read the same roadmap, picked the same top item, and never
looked at what was already proposed. One run diagnosed the problem and opened a PR about it — which
was, of course, the twelfth PR.

So, first, every run, before choosing anything:

```bash
gh pr list --state open --limit 30        # what is already proposed
git log --oneline -25                     # what already landed on main
```

If an open PR already covers the item you were about to pick, **do not open another**. Either
improve that branch, or pick a different item. If main already contains the fix, the roadmap is
stale — say so and update it, which is a full item in its own right. And check the item is still
real in the code in front of you before you write a line: `ROADMAP.md` describes the day it was
written, not necessarily today.

That same `gh pr list` also tells you something the duplicate check does not: whether the queue is
being reviewed at all. On 2026-09-11 it showed 30 open PRs (#24-#53), the oldest three days old,
CI green, with **zero comments and zero reviews** on every one sampled. Diagnosis was never the
bottleneck here; review was. Opening a 31st fix nobody has looked at yet does not help the person
waiting on the first ten — it only makes the queue longer to triage. So: if `gh pr list --state
open` returns more than 15 pull requests, **stop and say so instead of opening another one.** That
is a fine, honest outcome for the hour — the same as finding nothing worth doing.

## What to do in one run

Read `ROADMAP.md` and `README.md` in full first. `ROADMAP.md` is the memory between runs: what is
wanted, what is already done, what is known-broken, and the section **"Rules that must not be
broken"**, which you must read before changing anything.

Then pick **exactly one** open item and do it properly. One finished, honestly-described change is
worth more than three half-done ones. Prefer, in this order:

1. **A silent failure** — anywhere the app shows "nothing to report" when it actually failed to
   find out. This exact bug class has now recurred four separate times in this project: police
   street names (a regex that could never match), lit streets (impossible from a browser at all),
   the proximity warning, and an empty map when the CDN is blocked. Each one looked like calm.
2. **A claim that isn't true** — in the UI, the README or the roadmap. Correcting a false claim
   counts as a full item; say so in the PR.
3. **A small capability** from the roadmap.

If, after reading, nothing is genuinely worth doing, **say so and stop without opening a PR.** An
hour with no change is a fine outcome. Inventing work to look busy is not.

## What you cannot do

You have **no browser**: you cannot load the app, tap anything, or watch the map render. You have
**no database access and no Supabase credentials**: you cannot run a migration, query data, or
deploy an edge function. So you cannot verify any client-visible or backend behaviour end to end.

Write the code anyway — but say plainly in the PR what remains unverified and who has to check it.
**Never write "verified", "tested" or "confirmed" about something you only read.** Past runs of
this project were saved several times by someone noticing that a guard had never been watched
failing; a guard nobody has seen fail is not yet a guard.

## Before opening a PR

Run both of these and paste the real output into the PR body:

```bash
node tests/geo.test.js
for f in safewalk-app/geo.js safewalk-app/app.js safewalk-app/config.js safewalk-app/sw.js; do
  node -e "const fs=require('fs'),vm=require('vm');new vm.Script(fs.readFileSync('$f','utf8'),{filename:'$f'});console.log('$f parses')"
done
```

Do not run `tests/permissions.test.js` — it talks to the live database.

If you changed anything under `safewalk-app/`, bump `safewalk-app/version.json`, or every open app
keeps running the old build.

## How to deliver

Work on a branch and **open a PR against `main`. Never push to `main` directly** — a push to main
publishes to the live site, and you cannot verify a client change. Also update `ROADMAP.md` in the
same PR to match what is now true: that file is the next run's only memory, and a stale roadmap
sends the next agent to re-do finished work or to trust a fixed bug.

The PR description should say what changed, why it mattered, and — in its own paragraph — what you
could not check.
