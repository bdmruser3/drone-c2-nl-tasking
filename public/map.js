const MissionMap = (() => {
  let map, sectorLayer, baseLayer, lzLayer, perimeterLayer, missionLayer, droneLayer, obstacleLayer;
  const droneMarkers = [];
  const METERS_PER_DEGREE = 111320;

  function init(elId) {
    map = L.map(elId, { zoomControl: true, attributionControl: true }).setView([1.345, 103.82], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    sectorLayer = L.layerGroup().addTo(map);
    perimeterLayer = L.layerGroup().addTo(map);
    baseLayer = L.layerGroup().addTo(map);
    lzLayer = L.layerGroup().addTo(map);
    missionLayer = L.layerGroup().addTo(map);
    droneLayer = L.layerGroup().addTo(map);
    obstacleLayer = L.layerGroup().addTo(map);
    return map;
  }

  function divIcon(html, size) {
    return L.divIcon({ html, className: 'mm-icon', iconSize: size || [20, 20], iconAnchor: [(size ? size[0] : 20) / 2, (size ? size[1] : 20) / 2] });
  }

  function setStatic({ bases, lzs, sectors, perimeter }) {
    sectorLayer.clearLayers();
    perimeterLayer.clearLayers();
    baseLayer.clearLayers();
    lzLayer.clearLayers();

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

  function setObstacles(obstacles) {
    obstacleLayer.clearLayers();
    (obstacles || []).forEach((o) => {
      L.circle([o.lat, o.lng], {
        radius: o.radius * METERS_PER_DEGREE,
        color: '#8a6a52', weight: 1.5, dashArray: '3 4', fillColor: '#8a6a52', fillOpacity: 0.14,
      }).addTo(obstacleLayer);
      L.marker([o.lat, o.lng], {
        icon: divIcon(`<span style="color:#8a6a52;font-size:13px">&#9650;</span>`, [14, 14]),
        interactive: false,
      }).addTo(obstacleLayer)
        .bindTooltip(`${o.id} · ${o.height}m AGL · no-fly buffer ${Math.round(o.radius * METERS_PER_DEGREE)}m`, { permanent: false, direction: 'top' });
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

  function getMap() { return map; }

  return { init, setStatic, setObstacles, setMission, setDrones, getMap };
})();
