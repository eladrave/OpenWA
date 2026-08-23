'use strict';

// Dependency installation must never download/extract a browser. The production Docker stage
// installs its version-pinned Chrome only after the extract-zip symlink validation patch is applied.
module.exports = { skipDownload: true };
