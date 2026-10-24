## What

<!-- One or two sentences. What changes for someone using Loupe? -->

## Why

<!-- The problem this solves, or the issue it closes. -->

Closes #

## How

<!-- The approach, and anything a reviewer would trip over. Native protocol
changes should say which helpers (sources / capture / inputtap / render) moved. -->

## Testing

<!-- How you verified it. Which suites did you run? Which platform did you try
by hand? A short screen recording is a legitimate answer for UI changes. -->

- [ ] `npm test`
- [ ] Relevant `npm run test:e2e:*` suite
- [ ] Checked by hand on: <!-- macOS version / Windows version -->

## Checklist

- [ ] Focused on one change; unrelated cleanup split out
- [ ] Tests added or updated for behaviour changes
- [ ] Comments explain *why*, matching the surrounding code
- [ ] No new dependency without a stated reason, and none copyleft
- [ ] Docs or README updated if behaviour or setup changed
