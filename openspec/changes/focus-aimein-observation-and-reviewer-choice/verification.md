# Verification — 2026-10-29

## Result

Implemented configurable 1–3 reviewers with per-attempt frozen counts, legacy three-reviewer semantics, matching scene seats/routes and deterministic summaries. The default runtime field emphasizes saved-step progress, verified coverage, current activity and exceptions. Full channels, history and saved output remain accessible. Unsupported performance/efficiency metrics stay unmeasured.

## Checks

| Check | Result / evidence |
| --- | --- |
| Backend isolated regressions | 47 passed: `python -u -X faulthandler -m unittest tests.test_aimein tests.test_aimein_learning -v`; `.qa/aimein-task-landscape/reviewer-backend-final.log` |
| Frontend projection and acceptance regressions | 23 passed across aimein-world, aimein-play, aimein-runtime and aimein-review-summary; `.qa/aimein-task-landscape/frontend-unit-final.log` |
| TypeScript + Vite | Passed `npm run build`; `.qa/aimein-task-landscape/frontend-build-final.log`. Existing bundle-size advisory remains; no runtime performance claim follows from compilation. |
| Desktop + 360×640 runtime | Eight checks passed: configurable roster, prepare/plan/execute/review, independent output channels, history/offline/automatic assembly and complete saved-output paging; `observation-verified.log`, captures in `observation-pass/` |
| Reviewer interaction | Four checks passed: roster selection and keyboard/calibration on desktop and narrow layouts; `reviewer-final.log`, captures in `reviewer-pass/` |
| Complete one/two-reviewer acceptance | Two desktop/narrow checks passed with complete scoped reports showing stage acceptance and legacy partial reports remaining incomplete; `reviewer-acceptance.log`, captures in `reviewer-acceptance-pass/` |
| Existing workflows | Immersive preparation, reviewer workshop and playable construction lifecycle passed on desktop and narrow layouts in `observation-final.log`; its initial three failures were corrected and rerun in the checks above. |
| OpenSpec | Both this change and `refine-aimein-task-landscape` passed strict validation. |

All log and capture paths above are under `.qa/aimein-task-landscape/` unless given in full. Earlier runs exposed stale test selectors, the non-closing save behavior, narrow output crowding and scroll anchoring hiding the review overview. Tests were aligned with actual controls; the narrow layout and tool-switch scroll placement were fixed. Final roster checks require the overview to be physically inside the viewport.

Backend tests run the actual iteration/review control code with fake agent responses and temporary workspaces. They cover one/two actual review call counts, fresh isolated contexts, negative and missing reports, invalid count metadata and a mid-review reduction that preserves the original roster as stale. Frontend tests also keep a legacy one-report record incomplete under a current one-reviewer policy.

## Deliverables and limits

Actual React/WebGL screenshots and a 1600×900, approximately 14-second runtime recording are in `downloads/aimein-observation-20261029/`. The recording uses synthetic, explicitly isolated QA state/events; it is not a production model execution or an acceptance result for the user's project. No production Session was resumed, no OS permission or global Codex setting was changed, and the existing Windows installer was not rebuilt for this change.

The current guide is `docs/aimein-execution-mode.md`, section 20. Initial fixed-three descriptions are historical; the newer user request and version-2 attempt semantics govern current behavior.
