# Third-party notices

HarnessOS is distributed under the MIT License. It depends on, and in a few
places includes or adapts, the following third-party work.

## Skills adapted from Matt Pocock's skills repository

The skills under `.agents/skills/to-spec`, `.agents/skills/to-tickets`, and
`.agents/skills/grill-me` are adapted from
[mattpocock/skills](https://github.com/mattpocock/skills), which is distributed
under the MIT License.

Upstream copyright and license notice:

```text
MIT License

Copyright (c) Matt Pocock

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
```

## Runtime and development dependencies

The dependency tree is recorded in `pnpm-lock.yaml`. The direct dependencies
are distributed under permissive licenses:

| Package | License |
|---|---|
| `@larksuiteoapi/node-sdk` | MIT |
| `@modelcontextprotocol/sdk` | MIT |
| `cac` | MIT |
| `croner` | MIT |
| `dotenv` | BSD-2-Clause |
| `zod` | MIT |
| `@types/node` | MIT |
| `tsx` | MIT |
| `typescript` | Apache-2.0 |

Transitive dependencies may carry other permissive licenses; consult
`pnpm-lock.yaml` and each package's license file for the authoritative terms.
