const MissionMap = (() => {
  let map, sectorLayer, baseLayer, lzLayer, perimeterLayer, missionLayer, droneLayer, landmarkLayer;
  const droneMarkers = [];

  //: Lowest zoom at which each landmark tier is labelled. The gazetteer holds ~110
  //: places; drawing them all at once turns the AO into an unreadable wall of text, so
  //: detail appears as the operator zooms in. Resolution is unaffected — every name is
  //: accepted as a tasking target whatever the map is currently showing.
  const TIER_MIN_ZOOM = { 1: 0, 2: 12, 3: 13 };
  let landmarkData = [];

  function init(elId) {
    map = L.map(elId, { zoomControl: true, attributionControl: true }).setView([1.345, 103.82], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    sectorLayer = L.layerGroup().addTo(map);
    perimeterLayer = L.layerGroup().addTo(map);
    landmarkLayer = L.layerGroup().addTo(map);
    baseLayer = L.layerGroup().addTo(map);
    lzLayer = L.layerGroup().addTo(map);
    missionLayer = L.layerGroup().addTo(map);
    droneLayer = L.layerGroup().addTo(map);
    map.on('zoomend', renderLandmarks);
    return map;
  }

  /** Redraw the place labels visible at the current zoom. Cheap enough to run on every zoom. */
  function renderLandmarks() {
    if (!landmarkLayer) return;
    landmarkLayer.clearLayers();
    const zoom = map.getZoom();
    landmarkData
      .filter((p) => zoom >= (TIER_MIN_ZOOM[p.tier || 1] || 0))
      .forEach((p) => {
        L.circleMarker([p.lat, p.lng], { radius: 2, color: '#a49383', weight: 1, fillOpacity: 0.8, fillColor: '#a49383', interactive: false }).addTo(landmarkLayer);
        L.marker([p.lat, p.lng], {
          icon: divIcon(`<span style="position:absolute;left:6px;top:-6px;white-space:nowrap;font:500 9px ui-sans-serif;color:#a49383;text-shadow:0 0 3px #17120e,0 0 3px #17120e">${p.name}</span>`, [6, 6]),
          interactive: false,
        }).addTo(landmarkLayer);
      });
  }

  function divIcon(html, size) {
    return L.divIcon({ html, className: 'mm-icon', iconSize: size || [20, 20], iconAnchor: [(size ? size[0] : 20) / 2, (size ? size[1] : 20) / 2] });
  }

  function setStatic({ bases, lzs, sectors, perimeter, landmarks }) {
    sectorLayer.clearLayers();
    perimeterLayer.clearLayers();
    landmarkLayer.clearLayers();
    baseLayer.clearLayers();
    lzLayer.clearLayers();

    landmarkData = landmarks || [];
    renderLandmarks();

    sectors.forEach((s) => {
      L.rectangle([[s.lat0, s.lng0], [s.lat1, s.lng1]], {
        color: '#a49383', weight: 1, opacity: 0.35, fillOpacity: 0, dashArray: '4 4',
      }).addTo(sectorLayer);
      const cLat = (s.lat0 + s.lat1) / 2, cLng = (s.lng0 + s.lng1) / 2;
      L.marker([cLat, cLng], {
        icon: divIcon(`<span style="color:#a49383;font:600 11px ui-monospace,monospace;text-shadow:0 0 3px #17120e">S${s.n}</span>`, [24, 16]),
        interactive: false,
      }).addTo(sectorLayer);
    });

    L.polyline(perimeter, { color: '#a49383', weight: 1, opacity: 0.5, dashArray: '2 6' }).addTo(perimeterLayer);

    bases.forEach((b) => {
      L.marker([b.lat, b.lng], {
        icon: divIcon(`<span style="color:#e2703a;font-size:14px">&#9670;</span><span style="position:absolute;left:16px;top:0;white-space:nowrap;font:600 10px ui-sans-serif;color:#e2703a;text-shadow:0 0 3px #17120e">${b.name}</span>`, [16, 16]),
        interactive: false,
      }).addTo(baseLayer);
    });

    lzs.forEach((z) => {
      const color = z.clear ? '#7fae6a' : '#a49383';
      L.circleMarker([z.lat, z.lng], { radius: 7, color, weight: 2, fillOpacity: 0, dashArray: '3 3' }).addTo(lzLayer)
        .bindTooltip(`${z.tag} — ${z.note}`, { permanent: false, direction: 'top' });
    });
  }

  function setMission(mission) {
    missionLayer.clearLayers();
    if (!mission) return;
    L.polyline(mission.path, { color: '#e2703a', weight: 2, opacity: 0.7, dashArray: '6 6' }).addTo(missionLayer);
    L.circleMarker(mission.target, { radius: 9, color: '#e2703a', weight: 2, fillOpacity: 0.1 }).addTo(missionLayer)
      .bindTooltip(mission.label, { permanent: true, direction: 'top', className: 'mm-target-label' });
    L.circleMarker(mission.lz, { radius: 9, color: '#7fae6a', weight: 2, fillOpacity: 0.1 }).addTo(missionLayer);
  }

  function setDrones(drones) {
    while (droneMarkers.length > drones.length) {
      const m = droneMarkers.pop();
      droneLayer.removeLayer(m);
    }
    drones.forEach((d, i) => {
      if (!droneMarkers[i]) {
        droneMarkers[i] = L.circleMarker([d.lat, d.lng], { radius: 5, color: d.color, weight: 2, fillOpacity: 0.9, fillColor: d.color }).addTo(droneLayer);
      } else {
        droneMarkers[i].setLatLng([d.lat, d.lng]);
        droneMarkers[i].setStyle({ color: d.color, fillColor: d.color });
      }
    });
  }

  return { init, setStatic, setMission, setDrones };
})();
