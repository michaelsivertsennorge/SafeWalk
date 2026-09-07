# Instructions for the hourly maintenance agent

An hourly cloud routine runs an agent against this repository. It starts with **no memory of any
previous run** — this file, `ROADMAP.md` and `README.md` are everything it knows. If you are that
agent, this file is your brief. If you are a human changing how the agent behaves, change it here
rather than in the routine, so the reasoning stays next to the code.

SafeWalk is live and used by real people walking home at night. **A confident wrong claim about a
street is worse than a missing feature.** Everything below follows from that.

## What to do in one run

Read `ROADMAP.md` and `README.md` in full first. `ROADMAP.md` is the memory between runs: what is
wanted, what is already done, what is known-broken, and the section **"Rules that must not be
broken"**, which you must read before changing anything.

Then pick **exactly one** open item and do it properly. One finished, honestly-described change is
worth more than three half-done ones. Prefer, in this order:

1. **A silent failure** — anywhere the app shows "nothing to report" when it actually failed to
   find out. This exact bug class has now recurred five separate times in this project: police
   street names (a regex that could never match), lit streets (impossible from a browser at all),
   the proximity warning, an empty map when the CDN is blocked, and the police-events layer itself
   returning silently on any query error with no retry (see `ROADMAP.md`). Each one looked like calm.
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
