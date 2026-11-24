# SDK compatibility

The package supports the Pi SDK versions allowed by the peer dependency range in [package.json](../package.json). Read the range for `@earendil-works/pi-coding-agent`; the other Pi packages use the same range. The range is the support policy and the only place that states version support.

## Tested versions

- The `Quality` workflow installs the development dependency from `pnpm-lock.yaml` and runs the tests against that SDK.
- The `Compatibility` workflow reads the minimum version from the peer range, installs that version, and runs `pnpm test:integration` against it.
- Intermediate versions are not all tested. A pass at the minimum and at the development version is the support signal.

## Node versions

`.node-version` selects the Node version for development and CI. `engines.node` declares the oldest supported Node version. The `Quality` workflow tests both versions.

`@types/node` follows the pinned Node major and may drift within that major because it uses a caret range. Type checking against newer Node types does not prove that an API works on the support floor. The floor job runs the same tests on the oldest supported Node version. Code that uses APIs newer than that floor needs runtime coverage there, or the floor must be raised.

## Test another SDK

Set `PI_SDK_PATH` to the root directory of a `@earendil-works/pi-coding-agent` package. Then run the integration tests:

```sh
PI_SDK_PATH=/path/to/pi-coding-agent pnpm test:integration
```

The test support rejects a directory that is not a Pi coding agent package or that has no `dist/cli.js` or `dist/index.js`. It logs the version and path of each selected SDK once.

The integration tests check behavior: event-bus delivery, publication, RPC execution, and summary/subagent renderer callbacks rendered with the selected SDK's TUI dependency. They do not compare version strings or file hashes. If the selected SDK lacks a required export, the test names it.

## Upgrades

Update the development dependency to test a new SDK. Change the peer range only after `pnpm test:integration` passes at the new minimum; the compatibility workflow runs that command against the minimum.
