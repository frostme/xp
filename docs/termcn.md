# TermCN component provenance

The interactive setup UI uses Ink components copied from [shadcn-labs/termcn](https://github.com/shadcn-labs/termcn), retrieved from https://www.termcn.dev/r/ink/ on 2026-11-14. These components are distributed under the MIT license below. The CLI continues to use Ink 8 and React; no OpenTUI runtime is included.

Registry URLs and declared dependencies are recorded in `src/cli/termcn/registry-sources.json`. `components.json` configures the `@termcn` namespace and CLI-local `~/` aliases. Registry core files with explicit targets (including the theme provider) must be kept under the same CLI-local tree when updating.

Local adaptations:

- Import aliases, automatic JSX imports, and strict TypeScript compatibility.
- Controlled wizard steps, navigation visibility, compact progress, and completion labels.
- Focused-only input handling, selected-value cursor initialization, bounded option lists, batched keyboard events, and text-input cursor/control-key handling.
- Project-relative path completion that excludes symlinks and out-of-project traversal, while accepting paths that do not yet exist.
- Measured scroll content with natural height and constrained width; code tokens share a text flow so long lines wrap correctly; key/value labels and status icons keep their width.

The copied components retain their upstream exports for maintainable updates. Knip ignores unused exports/types only within this vendor directory; file reachability, dependencies, linting, and typechecking remain checked. Changes are exercised by real-Ink wizard, focus, path, and viewport tests. Application code does not render Ink primitives directly.

## Upstream license

MIT License

Copyright (c) 2026 Aniket Pawar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
