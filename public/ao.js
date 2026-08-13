/**
 * Area-of-operations gazetteer — the single source of truth for every place name
 * this system recognises. Loaded by the browser (as `window.AO`) and by server.js
 * (via require), so the map, the prompt, and the validator can never disagree about
 * which places exist.
 *
 * Every entry here corresponds to something drawn on the map: the two bases, the four
 * landing zones, the 3x3 sector grid, the north perimeter track, and the landmarks
 * labelled across the AO.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  //: Command enums. Shared so the server's validator and the review dialog's dropdowns
  //: are the same list — a dialog offering a value the validator rejects would be worse
  //: than no dialog at all.
  const TASK_TYPES = ['survey', 'patrol', 'recon', 'escort', 'resupply'];
  const LANDING = ['nearest_clear_approach', 'any_available', 'return_to_origin'];

  const BASES = [
    { name: 'Alpha', lat: 1.387, lng: 103.708, aliases: ['alpha', 'base alpha', 'fob alpha', 'a'] },
    { name: 'Bravo', lat: 1.358, lng: 103.909, aliases: ['bravo', 'base bravo', 'fob bravo', 'b'] },
  ];

  const LZS = [
    { tag: 'LZ-1 Kranji', lat: 1.425, lng: 103.755, clear: true, note: 'clear approach', aliases: ['lz 1', 'lz1', 'kranji', 'kranji lz'] },
    { tag: 'LZ-2 Marina', lat: 1.28, lng: 103.871, clear: false, note: 'obstructed', aliases: ['lz 2', 'lz2', 'marina', 'marina lz'] },
    { tag: 'LZ-3 Changi', lat: 1.345, lng: 104.005, clear: true, note: 'clear approach', aliases: ['lz 3', 'lz3', 'changi', 'changi lz'] },
    { tag: 'LZ-4 Sentosa', lat: 1.249, lng: 103.83, clear: true, note: 'clear approach', aliases: ['lz 4', 'lz4', 'sentosa', 'sentosa lz'] },
  ];

  const GRID = { lat0: 1.235, lat1: 1.455, lng0: 103.62, lng1: 104.04 };

  const SECTORS = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const dLat = (GRID.lat1 - GRID.lat0) / 3;
      const dLng = (GRID.lng1 - GRID.lng0) / 3;
      SECTORS.push({
        n: r * 3 + c + 1,
        lat1: GRID.lat1 - r * dLat,
        lat0: GRID.lat1 - (r + 1) * dLat,
        lng0: GRID.lng0 + c * dLng,
        lng1: GRID.lng0 + (c + 1) * dLng,
      });
    }
  }

  const PERIMETER = [[1.448, 103.65], [1.44, 103.72], [1.452, 103.78], [1.44, 103.85], [1.428, 103.92], [1.42, 103.99]];

  //: Named areas that are not a sector — drawn as their own geometry on the map.
  const AREAS = [
    {
      name: 'north_perimeter',
      lat: 1.443,
      lng: 103.8,
      aliases: ['north perimeter', 'northern perimeter', 'north border', 'northern border', 'perimeter', 'north edge'],
    },
  ];

  //: Prominent Singapore locations, plotted on the map and resolved to the sector that
  //: geometrically contains them — so "survey Ang Mo Kio" is as valid a tasking as
  //: "survey Sector 5". `tier` controls map label density: 1 is always drawn, 2 appears
  //: from zoom 12, 3 from zoom 13. Resolution ignores tier — every name here is
  //: accepted at any zoom.
  const LANDMARKS = [
    // --- North ---
    { name: 'Woodlands', lat: 1.436, lng: 103.786, tier: 1, aliases: ['woodlands'] },
    { name: 'Sembawang', lat: 1.4491, lng: 103.82, tier: 1, aliases: ['sembawang'] },
    { name: 'Yishun', lat: 1.429, lng: 103.835, tier: 1, aliases: ['yishun'] },
    { name: 'Kranji', lat: 1.425, lng: 103.7617, tier: 1, aliases: ['kranji'] },
    { name: 'Admiralty', lat: 1.4406, lng: 103.8009, tier: 2, aliases: ['admiralty'] },
    { name: 'Marsiling', lat: 1.4415, lng: 103.774, tier: 2, aliases: ['marsiling'] },
    { name: 'Lim Chu Kang', lat: 1.43, lng: 103.717, tier: 2, aliases: ['lim chu kang'] },
    { name: 'Sungei Buloh', lat: 1.4463, lng: 103.729, tier: 2, aliases: ['sungei buloh', 'buloh wetland'] },
    { name: 'Mandai', lat: 1.41, lng: 103.789, tier: 2, aliases: ['mandai', 'singapore zoo', 'mandai zoo', 'night safari'] },
    { name: 'Woodlands Checkpoint', lat: 1.447, lng: 103.769, tier: 2, aliases: ['woodlands checkpoint', 'causeway'] },
    { name: 'Sungei Kadut', lat: 1.413, lng: 103.753, tier: 3, aliases: ['sungei kadut'] },
    { name: 'Yew Tee', lat: 1.397, lng: 103.747, tier: 3, aliases: ['yew tee'] },
    { name: 'Simpang', lat: 1.43, lng: 103.83, tier: 3, aliases: ['simpang'] },

    // --- North-east ---
    { name: 'Punggol', lat: 1.4043, lng: 103.9021, tier: 1, aliases: ['punggol'] },
    { name: 'Sengkang', lat: 1.3868, lng: 103.8914, tier: 1, aliases: ['sengkang'] },
    { name: 'Seletar', lat: 1.405, lng: 103.869, tier: 1, aliases: ['seletar', 'seletar airport', 'seletar aerospace'] },
    { name: 'Pulau Ubin', lat: 1.41, lng: 103.965, tier: 1, aliases: ['pulau ubin', 'ubin'] },
    { name: 'Pulau Tekong', lat: 1.405, lng: 104.03, tier: 2, aliases: ['pulau tekong', 'tekong'] },
    { name: 'Coney Island', lat: 1.411, lng: 103.925, tier: 3, aliases: ['coney island'] },
    { name: 'Punggol Point', lat: 1.417, lng: 103.906, tier: 3, aliases: ['punggol point'] },
    { name: 'Lorong Halus', lat: 1.39, lng: 103.928, tier: 3, aliases: ['lorong halus'] },

    // --- Central north ---
    { name: 'Ang Mo Kio', lat: 1.3691, lng: 103.8454, tier: 1, aliases: ['ang mo kio', 'amk'] },
    { name: 'Bishan', lat: 1.351, lng: 103.848, tier: 1, aliases: ['bishan'] },
    { name: 'Serangoon', lat: 1.3554, lng: 103.8679, tier: 1, aliases: ['serangoon'] },
    { name: 'Hougang', lat: 1.3612, lng: 103.8863, tier: 1, aliases: ['hougang'] },
    { name: 'Toa Payoh', lat: 1.3343, lng: 103.8563, tier: 1, aliases: ['toa payoh', 'tpy'] },
    { name: 'Yio Chu Kang', lat: 1.3817, lng: 103.8449, tier: 2, aliases: ['yio chu kang'] },
    { name: 'MacRitchie', lat: 1.343, lng: 103.828, tier: 2, aliases: ['macritchie', 'macritchie reservoir'] },
    { name: 'Central Catchment', lat: 1.36, lng: 103.805, tier: 2, aliases: ['central catchment', 'catchment'] },
    { name: 'Thomson', lat: 1.354, lng: 103.836, tier: 3, aliases: ['thomson', 'upper thomson'] },
    { name: 'Braddell', lat: 1.3405, lng: 103.847, tier: 3, aliases: ['braddell'] },
    { name: 'Potong Pasir', lat: 1.3312, lng: 103.8686, tier: 3, aliases: ['potong pasir'] },

    // --- West ---
    { name: 'Jurong East', lat: 1.333, lng: 103.742, tier: 1, aliases: ['jurong east', 'jurong'] },
    { name: 'Jurong West', lat: 1.34, lng: 103.709, tier: 1, aliases: ['jurong west'] },
    { name: 'Choa Chu Kang', lat: 1.384, lng: 103.747, tier: 1, aliases: ['choa chu kang', 'cck'] },
    { name: 'Bukit Panjang', lat: 1.3786, lng: 103.764, tier: 1, aliases: ['bukit panjang'] },
    { name: 'Bukit Batok', lat: 1.359, lng: 103.7637, tier: 1, aliases: ['bukit batok'] },
    { name: 'Clementi', lat: 1.3162, lng: 103.7649, tier: 1, aliases: ['clementi'] },
    { name: 'Boon Lay', lat: 1.3386, lng: 103.706, tier: 2, aliases: ['boon lay'] },
    { name: 'Pioneer', lat: 1.3376, lng: 103.697, tier: 2, aliases: ['pioneer'] },
    { name: 'Tengah', lat: 1.369, lng: 103.715, tier: 2, aliases: ['tengah'] },
    { name: 'NTU', lat: 1.3483, lng: 103.6831, tier: 2, aliases: ['ntu', 'nanyang technological university', 'nanyang'] },
    { name: 'Bukit Gombak', lat: 1.359, lng: 103.7517, tier: 3, aliases: ['bukit gombak'] },
    { name: 'Science Centre', lat: 1.333, lng: 103.736, tier: 3, aliases: ['science centre', 'science center'] },
    { name: 'Teban Gardens', lat: 1.322, lng: 103.744, tier: 3, aliases: ['teban gardens'] },
    { name: 'Pandan', lat: 1.318, lng: 103.749, tier: 3, aliases: ['pandan', 'pandan reservoir'] },

    // --- South-west ---
    { name: 'Tuas', lat: 1.294, lng: 103.636, tier: 1, aliases: ['tuas'] },
    { name: 'Jurong Island', lat: 1.264, lng: 103.7, tier: 1, aliases: ['jurong island'] },
    { name: 'Tuas Checkpoint', lat: 1.348, lng: 103.635, tier: 2, aliases: ['tuas checkpoint', 'second link'] },
    { name: 'Western Islands', lat: 1.25, lng: 103.74, tier: 3, aliases: ['western islands'] },

    // --- Central west ---
    { name: 'Bukit Timah', lat: 1.3294, lng: 103.8021, tier: 1, aliases: ['bukit timah'] },
    { name: 'Bukit Timah Nature Reserve', lat: 1.354, lng: 103.7764, tier: 2, aliases: ['bukit timah nature reserve', 'bukit timah hill', 'nature reserve'] },
    { name: 'Holland Village', lat: 1.311, lng: 103.796, tier: 2, aliases: ['holland village', 'holland v'] },
    { name: 'Botanic Gardens', lat: 1.3138, lng: 103.8159, tier: 1, aliases: ['botanic gardens', 'botanic garden'] },
    { name: 'Newton', lat: 1.312, lng: 103.838, tier: 2, aliases: ['newton'] },
    { name: 'Novena', lat: 1.3203, lng: 103.8438, tier: 2, aliases: ['novena'] },
    { name: 'Ghim Moh', lat: 1.311, lng: 103.788, tier: 3, aliases: ['ghim moh'] },
    { name: 'Dover', lat: 1.311, lng: 103.7786, tier: 3, aliases: ['dover'] },

    // --- East ---
    { name: 'Tampines', lat: 1.353, lng: 103.945, tier: 1, aliases: ['tampines'] },
    { name: 'Pasir Ris', lat: 1.3721, lng: 103.9493, tier: 1, aliases: ['pasir ris'] },
    { name: 'Bedok', lat: 1.3236, lng: 103.9273, tier: 1, aliases: ['bedok'] },
    { name: 'Changi', lat: 1.345, lng: 104.005, tier: 1, aliases: ['changi'] },
    { name: 'Changi Airport', lat: 1.3644, lng: 103.9915, tier: 1, aliases: ['changi airport', 'the airport', 'airport'] },
    { name: 'Simei', lat: 1.3434, lng: 103.953, tier: 2, aliases: ['simei'] },
    { name: 'Tanah Merah', lat: 1.3272, lng: 103.9463, tier: 2, aliases: ['tanah merah'] },
    { name: 'Bedok Reservoir', lat: 1.34, lng: 103.92, tier: 3, aliases: ['bedok reservoir'] },
    { name: 'Changi Business Park', lat: 1.334, lng: 103.966, tier: 3, aliases: ['changi business park'] },
    { name: 'Loyang', lat: 1.367, lng: 103.976, tier: 3, aliases: ['loyang'] },
    { name: 'Eunos', lat: 1.3196, lng: 103.9032, tier: 3, aliases: ['eunos'] },
    { name: 'Siglap', lat: 1.312, lng: 103.928, tier: 3, aliases: ['siglap'] },

    // --- Central east ---
    { name: 'Geylang', lat: 1.318, lng: 103.887, tier: 2, aliases: ['geylang'] },
    { name: 'Paya Lebar', lat: 1.318, lng: 103.893, tier: 2, aliases: ['paya lebar'] },
    { name: 'Kallang', lat: 1.311, lng: 103.871, tier: 2, aliases: ['kallang', 'sports hub'] },
    { name: 'MacPherson', lat: 1.3266, lng: 103.8899, tier: 3, aliases: ['macpherson'] },
    { name: 'Ubi', lat: 1.33, lng: 103.895, tier: 3, aliases: ['ubi'] },
    { name: 'Aljunied', lat: 1.3165, lng: 103.8829, tier: 3, aliases: ['aljunied'] },

    // --- South-east coast ---
    { name: 'East Coast', lat: 1.301, lng: 103.93, tier: 1, aliases: ['east coast', 'east coast park'] },
    { name: 'Marine Parade', lat: 1.302, lng: 103.906, tier: 1, aliases: ['marine parade'] },
    { name: 'Katong', lat: 1.305, lng: 103.902, tier: 2, aliases: ['katong'] },
    { name: 'Marina East', lat: 1.295, lng: 103.876, tier: 3, aliases: ['marina east'] },

    // --- Downtown core ---
    { name: 'Marina Bay', lat: 1.283, lng: 103.86, tier: 1, aliases: ['marina bay', 'marina'] },
    { name: 'Marina Bay Sands', lat: 1.2834, lng: 103.8607, tier: 2, aliases: ['marina bay sands', 'mbs'] },
    { name: 'Gardens by the Bay', lat: 1.2816, lng: 103.8636, tier: 2, aliases: ['gardens by bay', 'gardens by the bay'] },
    { name: 'Raffles Place', lat: 1.284, lng: 103.851, tier: 1, aliases: ['raffles place', 'cbd', 'central business district', 'downtown'] },
    { name: 'Orchard', lat: 1.3048, lng: 103.8318, tier: 1, aliases: ['orchard', 'orchard road'] },
    { name: 'Chinatown', lat: 1.283, lng: 103.844, tier: 2, aliases: ['chinatown'] },
    { name: 'Little India', lat: 1.3066, lng: 103.8496, tier: 2, aliases: ['little india'] },
    { name: 'Bugis', lat: 1.301, lng: 103.856, tier: 2, aliases: ['bugis', 'kampong glam'] },
    { name: 'City Hall', lat: 1.293, lng: 103.852, tier: 2, aliases: ['city hall', 'city centre', 'city center'] },
    { name: 'Esplanade', lat: 1.2897, lng: 103.8558, tier: 2, aliases: ['esplanade'] },
    { name: 'Clarke Quay', lat: 1.2907, lng: 103.8465, tier: 2, aliases: ['clarke quay'] },
    { name: 'Boat Quay', lat: 1.287, lng: 103.85, tier: 3, aliases: ['boat quay'] },
    { name: 'Robertson Quay', lat: 1.291, lng: 103.839, tier: 3, aliases: ['robertson quay'] },
    { name: 'Merlion Park', lat: 1.2868, lng: 103.8545, tier: 3, aliases: ['merlion park', 'merlion'] },
    { name: 'Singapore Flyer', lat: 1.2893, lng: 103.8631, tier: 3, aliases: ['singapore flyer', 'flyer'] },
    { name: 'Dhoby Ghaut', lat: 1.299, lng: 103.8455, tier: 3, aliases: ['dhoby ghaut'] },
    { name: 'Fort Canning', lat: 1.294, lng: 103.846, tier: 3, aliases: ['fort canning'] },
    { name: 'Somerset', lat: 1.3006, lng: 103.8388, tier: 3, aliases: ['somerset'] },
    { name: 'River Valley', lat: 1.293, lng: 103.829, tier: 3, aliases: ['river valley'] },
    { name: 'Tanglin', lat: 1.307, lng: 103.818, tier: 2, aliases: ['tanglin'] },
    { name: 'Dempsey', lat: 1.305, lng: 103.81, tier: 3, aliases: ['dempsey'] },
    { name: 'Marina South', lat: 1.27, lng: 103.863, tier: 3, aliases: ['marina south'] },

    // --- South-west coast ---
    { name: 'Queenstown', lat: 1.2942, lng: 103.7861, tier: 1, aliases: ['queenstown'] },
    { name: 'HarbourFront', lat: 1.2653, lng: 103.822, tier: 2, aliases: ['harbourfront', 'vivocity'] },
    { name: 'Sentosa', lat: 1.2494, lng: 103.8303, tier: 1, aliases: ['sentosa'] },
    { name: 'Bukit Merah', lat: 1.2819, lng: 103.8239, tier: 2, aliases: ['bukit merah'] },
    { name: 'Tiong Bahru', lat: 1.286, lng: 103.827, tier: 2, aliases: ['tiong bahru'] },
    { name: 'Pasir Panjang', lat: 1.276, lng: 103.791, tier: 2, aliases: ['pasir panjang'] },
    { name: 'NUS', lat: 1.2966, lng: 103.7764, tier: 2, aliases: ['nus', 'national university of singapore'] },
    { name: 'one-north', lat: 1.299, lng: 103.787, tier: 2, aliases: ['one north', 'onenorth'] },
    { name: 'Buona Vista', lat: 1.307, lng: 103.79, tier: 2, aliases: ['buona vista'] },
    { name: 'West Coast', lat: 1.296, lng: 103.762, tier: 2, aliases: ['west coast'] },
    { name: 'Keppel', lat: 1.27, lng: 103.825, tier: 3, aliases: ['keppel', 'keppel harbour'] },
    { name: 'Labrador', lat: 1.267, lng: 103.802, tier: 3, aliases: ['labrador'] },
    { name: 'Kent Ridge', lat: 1.293, lng: 103.784, tier: 3, aliases: ['kent ridge'] },
    { name: 'Redhill', lat: 1.2897, lng: 103.8168, tier: 3, aliases: ['redhill'] },
  ];

  /** Lowercase, de-punctuate, drop articles — so "the North_Perimeter!" matches "north perimeter". */
  function norm(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[_\-]+/g, ' ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\bthe\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function centreOf(sector) {
    return { lat: (sector.lat0 + sector.lat1) / 2, lng: (sector.lng0 + sector.lng1) / 2 };
  }

  /** Which sector contains this point, or null if it falls outside the grid. */
  function sectorAt(lat, lng) {
    const hit = SECTORS.find((s) => lat >= s.lat0 && lat <= s.lat1 && lng >= s.lng0 && lng <= s.lng1);
    return hit ? hit.n : null;
  }

  /** True when `alias` appears in `q` as a whole phrase, so "jurong" does not match "jurongx". */
  function containsPhrase(q, alias) {
    const i = q.indexOf(alias);
    if (i === -1) return false;
    const before = i === 0 ? ' ' : q[i - 1];
    const after = i + alias.length >= q.length ? ' ' : q[i + alias.length];
    return before === ' ' && after === ' ';
  }

  /** Best alias match across a list, preferring the longest alias so "jurong island" beats "jurong". */
  function matchByAlias(q, items) {
    let best = null;
    let bestLen = 0;
    items.forEach((item) => {
      item.aliases.forEach((alias) => {
        if (alias.length > bestLen && (q === alias || containsPhrase(q, alias))) {
          best = item;
          bestLen = alias.length;
        }
      });
    });
    return best;
  }

  /**
   * Resolve an operator/model place label to a real location on the map.
   * Returns null when the name is not in this gazetteer — that is the signal that the
   * value was invented, and the caller must flag it rather than plot it somewhere.
   */
  function resolvePlace(raw) {
    const q = norm(raw);
    if (!q) return null;

    const sectorMatch = /^sector (\d+)$/.exec(q) || /^s(\d+)$/.exec(q);
    if (sectorMatch) {
      const n = parseInt(sectorMatch[1], 10);
      const sector = SECTORS.find((s) => s.n === n);
      if (!sector) return null; // e.g. "Sector 47" — grid only runs 1-9
      const c = centreOf(sector);
      return { kind: 'sector', canonical: 'Sector ' + n, sector: n, lat: c.lat, lng: c.lng, label: 'SECTOR ' + n };
    }

    const area = matchByAlias(q, AREAS);
    if (area) {
      return { kind: 'area', canonical: area.name, sector: sectorAt(area.lat, area.lng), lat: area.lat, lng: area.lng, label: area.name.replace(/_/g, ' ').toUpperCase() };
    }

    const landmark = matchByAlias(q, LANDMARKS);
    if (landmark) {
      return { kind: 'landmark', canonical: landmark.name, sector: sectorAt(landmark.lat, landmark.lng), lat: landmark.lat, lng: landmark.lng, label: landmark.name.toUpperCase() };
    }

    const lz = matchByAlias(q, LZS);
    if (lz) {
      return { kind: 'lz', canonical: lz.tag, sector: sectorAt(lz.lat, lz.lng), lat: lz.lat, lng: lz.lng, label: lz.tag.toUpperCase() };
    }

    return null;
  }

  /** Resolve a launch point. Only a base is a valid origin; null means unrecognised. */
  function resolveOrigin(raw) {
    const q = norm(raw);
    if (!q) return null;
    const base = matchByAlias(q, BASES);
    if (!base) return null;
    return { kind: 'base', canonical: base.name, sector: sectorAt(base.lat, base.lng), lat: base.lat, lng: base.lng, label: 'BASE ' + base.name.toUpperCase() };
  }

  /**
   * The roster injected into the system prompt, so the model knows the real place names
   * on its first attempt instead of inventing plausible ones.
   */
  function promptRoster() {
    const bySector = SECTORS.map((s) => {
      const here = LANDMARKS.filter((l) => sectorAt(l.lat, l.lng) === s.n).map((l) => l.name);
      return '  Sector ' + s.n + (here.length ? ' — ' + here.join(', ') : '');
    }).join('\n');

    return [
      'Known locations in this area of operations:',
      '- Launch bases (the only valid non-null values for "origin"): ' + BASES.map((b) => b.name).join(', '),
      '- Sectors (valid values for "target_sector"): Sector 1 through Sector 9, containing:',
      bySector,
      '- Named areas: ' + AREAS.map((a) => a.name).join(', '),
      '- Landing zones: ' + LZS.map((z) => z.tag).join(', '),
      '',
      'A landmark name may be used as target_sector in place of its sector number.',
      'If the tasking names a place that is NOT listed above, record exactly what the',
      'operator wrote. Never substitute a nearby known place for an unknown one.',
    ].join('\n');
  }

  /** Every value accepted for `target_sector`, grouped for the review dialog's dropdown. */
  function targetOptions() {
    return [
      { group: 'Sectors', names: SECTORS.map((s) => 'Sector ' + s.n) },
      { group: 'Named areas', names: AREAS.map((a) => a.name) },
      { group: 'Landmarks', names: LANDMARKS.map((l) => l.name).slice().sort() },
    ];
  }

  return {
    TASK_TYPES, LANDING, BASES, LZS, GRID, SECTORS, PERIMETER, AREAS, LANDMARKS,
    norm, centreOf, sectorAt, resolvePlace, resolveOrigin, promptRoster, targetOptions,
  };
});
