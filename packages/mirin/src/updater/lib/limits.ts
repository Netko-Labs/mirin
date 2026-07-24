export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_VERSION_JSON_BYTES = 16 * 1024;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_PATCH_BYTES = 512 * 1024 * 1024;
/** Old tar + raw patch are both held in memory by qbsdiff patch application. */
export const MAX_PATCH_MEMORY_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_TAR_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_PATCH_COUNT = 64;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_PATH_BYTES = 4096;
export const MAX_ARCHIVE_LINK_BYTES = 4096;
export const MAX_PAX_HEADER_BYTES = 64 * 1024;
