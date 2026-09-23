# Night Watch web UI design QA

None of the images below is in the repository. The source reference was a generated
image in the original author's local Codex image cache, and the captures were written
to the gitignored `ai-runs/`, so on any other checkout these paths name nothing; they
are kept as a record of what was compared.

Source reference (the author's local Codex cache, outside the repo):
`generated_images/019ff3ec-305c-7af1-bb10-3c4aa77363c9/exec-c4c3a391-94b9-4ce7-a233-496e2ee1bc9d.png`

Final implementation captures (repo-relative, gitignored):

- Desktop, 1487 × 1058, Wolf-Winter Byre-Yard root dialogue:
  `ai-runs/night-watch-design-qa/implementation-1487x1058-v5.png`
- Mobile, 360 × 800, same authored state:
  `ai-runs/night-watch-design-qa/mobile-quest-360x800-v4.png`

Comparison history:

1. Initial implementation over-expanded the authored briefing and pushed the
   action surface below the dock.
2. The scene was split into prose, a short attributed dialogue lead, and an
   expandable full briefing; scrolling now resets at each state transition.
3. The final pass reduced dense-card type, kept buttons visible at the dock
   boundary, removed a misleading fixed pressure scale, and removed horizontal
   page overflow at 360 px.

Faithfulness assessment:

- Matched the selected Night Watch direction: charcoal textured field surface,
  condensed uppercase hierarchy, serif narrative, mono metadata, cyan/orange/
  lichen accents, thin rules, scene/objective split, consequence rail, decision
  deck, and fixed utility dock.
- Deliberately did not copy the mock's four root Commit cards or normalized
  five-position pressure meters. The canonical root state exposes ASK actions
  plus movement/observation, and authored pressure tracks have different
  thresholds. Inventing those controls would misrepresent game legality.
- The engine-projected flat action set can exceed one viewport. All actions stay
  available through the scrolling deck and Exact Terms; that density is an
  accepted growing pain in favor of preserving game authority.

Primary interactions verified:

- Fresh journey tutorial and registration flow.
- Overworld local action, consequences, Exact Terms, and dispatch approaches.
- Wolf-Winter launch, quest action, strategy dialogue, progressive briefing,
  pressure presentation, and utility dock.
- Mid-quest reload rolls back to a relaunchable pre-quest road save.
- Desktop and 360 px responsive states.

Console errors: none. Only Vite development connection/HMR messages and the
React DevTools informational message were present.

Final result: passed
