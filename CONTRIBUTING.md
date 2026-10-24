# Contributing to Loupe

Thanks for wanting to help. Loupe is MIT-licensed and open to changes of any
size — bug fixes, platform coverage, docs, or a feature you wish existed.

## Before you start

- **Bugs and small fixes** — open a PR directly.
- **New features or big refactors** — open an issue first so we agree on the
  approach before you spend time on it. Loupe has a deliberately narrow scope:
  it's a screen recorder whose job is zooming into detail for demo videos.
- **Security issues** — please don't open a public issue. Email
  [akshatg9636@gmail.com](mailto:akshatg9636@gmail.com).

## Getting set up

```sh
git clone https://github.com/akshatgg/loupe.git
cd loupe
npm install
npm run build:native   # Swift helpers -> bin/ (macOS: arm64 + x86_64)
npm start
```

The app drives four native helpers — `sources`, `capture`, `inputtap` and
`render`. On macOS they're Swift in `src/native`, built by
`packaging/build-native.sh`. On Windows it's one .NET 8 program in
`native-win`, built with `npm run build:native:win`. `src/main/platform.js`
picks between them, so a change to the native protocol usually touches both.

`docs/` holds the product and technical design — worth a skim before
touching the editor or the export pipeline.

## Checks

Everything CI runs, run locally before pushing:

```sh
npm test                 # eslint + node:test unit tests
npm run test:e2e         # Electron end-to-end suites
npm run test:native:win  # Windows helper tests (any OS, needs .NET 8)
```

The e2e suite is split by area (`test:e2e:editor`, `test:e2e:captions`,
`test:e2e:export`, …) so you can run just the one you touched. Adding a test
for a bug fix is expected; adding one for a new feature is strongly preferred.

## Style

- Match the surrounding code — naming, structure, and comment density. The
  existing code is fairly dense with comments explaining *why*, not *what*.
- No new dependencies unless there's a real reason. Loupe ships as a desktop
  app and every dependency is a supply-chain and bundle-size cost.
- No GPL/AGPL dependencies — they can't be shipped under MIT.
- Keep `master` shippable. Features that aren't finished should sit behind a
  flag or stay on the branch.

## Commits and PRs

- [Conventional Commits](https://www.conventionalcommits.org/) for messages:
  `fix:`, `feat:`, `chore:`, `docs:`, `refactor:`, `test:`.
- One logical change per PR. If a fix needs unrelated cleanup, split it.
- Fill in the PR template — especially **how you tested it**. "Ran
  `test:e2e:editor`" or a screen recording of the behaviour both work.
- Reference the issue with `Closes #123` when applicable.

## License

By contributing you agree your contribution is licensed under the
[MIT License](LICENSE) and that you have the right to submit it.
