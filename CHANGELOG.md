## [0.7.1](https://github.com/semics-tech/mongolite/compare/v0.7.0...v0.7.1) (2026-03-24)


### Bug Fixes

* **ci:** repair publish workflow — broken action versions and missing npm auth ([#44](https://github.com/semics-tech/mongolite/issues/44)) ([8745bad](https://github.com/semics-tech/mongolite/commit/8745bad3cb1e27932faf6427b69ebe90944e793f))

# [0.7.0](https://github.com/semics-tech/mongolite/compare/v0.6.2...v0.7.0) (2026-03-24)


### Bug Fixes

* restore Dependabot functionality — missing labels, lint errors, and npm vulnerabilities ([#23](https://github.com/semics-tech/mongolite/issues/23)) ([f6eff71](https://github.com/semics-tech/mongolite/commit/f6eff711b07e489e11d831bb67048c82514cfbdb))
* separate semantic release from npm publish; add tag-triggered publish workflow; set Node 24 as default (LTS) ([#36](https://github.com/semics-tech/mongolite/issues/36)) ([4de8a36](https://github.com/semics-tech/mongolite/commit/4de8a3668b2219cfa243d01fde1bdfb70669b486))


### Features

* automated semantic versioning and npm publish pipeline ([#29](https://github.com/semics-tech/mongolite/issues/29)) ([4959460](https://github.com/semics-tech/mongolite/commit/49594603a796941737068ad2075dc69e54fb8f49))
* MongoDB client feature parity for mongolite ([#27](https://github.com/semics-tech/mongolite/issues/27)) ([af1a7d5](https://github.com/semics-tech/mongolite/commit/af1a7d5e96c598dce5578e9b58c22b0a86755323))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-06-26

### Changed
- Migrated from sqlite3 to better-sqlite3 for improved performance
- Added support for Write-Ahead Logging (WAL) mode
- Updated documentation and examples to reflect new dependency

## [0.1.0] - 2025-05-31

### Added
- Initial release
- Basic MongoDB-like API with SQLite backend
- Support for CRUD operations (insertOne, findOne, find, updateOne, deleteOne)
- Query operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists
- Update operators: $set, $unset, $inc, $push, $pull
- FindCursor with support for limit, skip, sort, and projection
- Comprehensive test suite
- Documentation and examples
