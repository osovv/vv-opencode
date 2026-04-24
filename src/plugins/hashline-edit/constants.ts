// FILE: src/plugins/hashline-edit/constants.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the stable hashline alphabet and reference parsing patterns used by the hash-anchored edit plugin.
//   SCOPE: Hash dictionary generation plus regular expressions for `{line}#{hash}` references and hashline output rows.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HASHLINE_NIBBLES - Canonical 16-character alphabet used to encode 8-bit line hashes.
//   HASHLINE_DICT - Lookup table that maps 0-255 byte values to two-character hash IDs.
//   HASHLINE_REF_PATTERN - Regex for normalized `{line}#{hash}` anchors.
//   HASHLINE_OUTPUT_PATTERN - Regex for rendered `line#hash|content` rows.
// END_MODULE_MAP

export const HASHLINE_NIBBLES = "ZPMQVRWSNKTXJBYH";

export const HASHLINE_DICT = Array.from({ length: 256 }, (_, index) => {
  const high = index >>> 4;
  const low = index & 0x0f;
  return `${HASHLINE_NIBBLES[high]}${HASHLINE_NIBBLES[low]}`;
});

export const HASHLINE_REF_PATTERN =
  /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})(?:#([ZPMQVRWSNKTXJBYH]{2}))?$/;
export const HASHLINE_OUTPUT_PATTERN =
  /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})(?:#([ZPMQVRWSNKTXJBYH]{2}))?\|(.*)$/;
