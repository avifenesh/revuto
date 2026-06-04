# Changelog

## v0.1.1 - 2026-06-04

### Added

- Add local Revuto dashboard.
- Add Bedrock Mantle Responses support.
- Never review draft PRs.
- Sign posted comments with a revuto attribution footer.

### Fixed

- Check out PR head by SHA, not a persisted remote-tracking ref.
- Handle GLM tool-shyness by enforcing a terminal tool call.
- Use proper embed mode in `llama-server.sh`.
- Drop hardcoded `REVUTO_CONFIG` from systemd unit.

### Changed

- Serialize revuto jobs per repo.
- Polish store selection and review signature.
- Make the vault the default config home.
- Allow the config to live inside the vault.

### Documentation

- Update plan for Responses model support.

### Other

- Bump `ai` from 6.0.188 to 6.0.191.
- Bump `@ai-sdk/openai-compatible` from 2.0.47 to 2.0.48.
- Ignore TypeScript major bumps in dependabot.
- Validate repo arg in `reviewOnePr`.
