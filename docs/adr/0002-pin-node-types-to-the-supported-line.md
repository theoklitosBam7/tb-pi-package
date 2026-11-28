# Pin @types/node to the supported Node line

The package supports Node 22.22.3 and newer through `engines.node`, and pi itself requires Node 22.19.0 or newer. Development runs on the Node.js version in `.node-version`.

`@types/node` follows the 22 line (`^22.20.7`) rather than the development runtime. Types for the newest Node make `pnpm typecheck` accept APIs that do not exist on the supported floor, and nothing else checks for that: the test suite and CI run on the version in `.node-version` only. Types on the 22 line make the type checker reject those APIs, while the development and CI runtimes stay on the version in `.node-version`.

We considered a CI job on Node 22.22.3 instead. It would catch runtime failures in tested code, but it would not stop the use of newer APIs before they are written, and it doubles CI time.

The trade-off is that code which only runs in development, including tests and scripts, cannot use typings newer than the supported line. The 22 line also ends at 22.20.7, so a few APIs added in Node 22.21 and 22.22 are rejected. That is stricter than the floor and can be relaxed if it starts to block work.
