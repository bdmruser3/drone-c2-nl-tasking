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

  // Shift a latlng by a screen-pixel offset at the current zoom, so formation
  // spacing stays legible instead of collapsing to sub-pixel distances.
  function pixelOffset(latlng, dx, dy) {
    const p = map.latLngToContainerPoint(latlng);
    const q = map.containerPointToLatLng([p.x + dx, p.y + dy]);
    return [q.lat, q.lng];
  }

  function setMission(mission) {
    missionLayer.clearLayers();
    if (!mission) return;
    L.polyline(mission.path, { color: '#e2703a', weight: 2, opacity: 0.7, dashArray: '6 6' }).addTo(missionLayer);
    L.circleMarker(mission.target, { radius: 9, color: '#e2703a', weight: 2, fillOpacity: 0.1 }).addTo(missionLayer)
      .bindTooltip(mission.label, { permanent: true, direction: 'top', className: 'mm-target-label' });
    L.circleMarker(mission.lz, { radius: 9, color: '#7fae6a', weight: 2, fillOpacity: 0.1 }).addTo(missionLayer);
  }

  // Top-down quadcopter: X frame, four rotor discs with a spinning blade, body
  // pod with a lens dot. Blades spin via CSS (see .mm-rotor) so the animation
  // costs nothing per frame — setDrones runs on every rAF tick.
  const DRONE_PX = 22;
  const HUBS = [[4.6, 4.6], [17.4, 4.6], [4.6, 17.4], [17.4, 17.4]];

  function droneSvg(color) {
    const rotors = HUBS.map(([cx, cy], i) => `
      <circle cx="${cx}" cy="${cy}" r="3.6" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".65" stroke-width=".8"/>
      <line class="mm-rotor" style="animation-delay:${i * 0.05}s" x1="${cx - 3.3}" y1="${cy}" x2="${cx + 3.3}" y2="${cy}" stroke="${color}" stroke-width="1.1" stroke-linecap="round"/>`).join('');
    return `<svg width="${DRONE_PX}" height="${DRONE_PX}" viewBox="0 0 22 22" style="overflow:visible;filter:drop-shadow(0 0 2px #17120e)">
      <path d="M4.6 4.6 17.4 17.4 M17.4 4.6 4.6 17.4" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity=".9"/>
      ${rotors}
      <rect x="8" y="8" width="6" height="6" rx="1.8" fill="${color}"/>
      <circle cx="11" cy="11" r="1.1" fill="#17120e" fill-opacity=".65"/>
    </svg>`;
  }

  function setDrones(drones) {
    while (droneMarkers.length > drones.length) {
      const m = droneMarkers.pop();
      droneLayer.removeLayer(m);
    }
    drones.forEach((d, i) => {
      const pos = [d.lat, d.lng];
      if (!droneMarkers[i]) {
        const marker = L.marker(pos, { icon: divIcon(droneSvg(d.color), [DRONE_PX, DRONE_PX]), interactive: false });
        marker._mmColor = d.color;
        droneMarkers[i] = marker.addTo(droneLayer);
      } else {
        droneMarkers[i].setLatLng(pos);
        // Rebuilding the icon restarts the rotor animation, so only on a real
        // colour change (drone type switched), never every frame.
        if (droneMarkers[i]._mmColor !== d.color) {
          droneMarkers[i]._mmColor = d.color;
          droneMarkers[i].setIcon(divIcon(droneSvg(d.color), [DRONE_PX, DRONE_PX]));
        }
      }
    });
  }

  function getMap() { return map; }

  return { init, setStatic, setObstacles, setMission, setDrones, pixelOffset, getMap };
})();
