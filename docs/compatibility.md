# SDK compatibility

The package supports the Pi SDK versions allowed by the peer dependency range in [package.json](../package.json). Read the range for `@earendil-works/pi-coding-agent`; the other Pi packages use the same range. The range is the support policy and the only place that states version support.

## Tested versions

- The `Quality` workflow installs the development dependency from `pnpm-lock.yaml` and runs the tests against that SDK.
- The `Compatibility` workflow reads the minimum version from the peer range, installs that version, and runs `pnpm test:integration` against it.
- Intermediate versions are not all tested. A pass at the minimum and at the development version is the support signal.

## Test another SDK

Set `PI_SDK_PATH` to the root directory of a `@earendil-works/pi-coding-agent` package. Then run the integration tests:

```sh
PI_SDK_PATH=/path/to/pi-coding-agent pnpm test:integration
```

The test support rejects a directory that is not a Pi coding agent package or that has no `dist/cli.js`. It logs the selected version and path once.

The integration tests check behavior: event-bus delivery, publication, and RPC execution. They do not compare version strings or file hashes. If the selected SDK lacks a required export, the test names it.

## Upgrades

Update the development dependency to test a new SDK. Change the peer range only after the integration tests pass at the new minimum; the compatibility workflow then tests that minimum.
