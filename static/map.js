const EcoRouteMap = (() => {
  const defaultCenter = [14.25, 121.15];
  let userMap;
  let hubMap;
  let requestMap;
  let userPin;
  let adminPin;
  let requestLocationMarker;
  let userHubMarkers = [];
  let adminHubMarkers = [];
  let requestHubMarkers = [];
  const logoUrl = new URL("ecoroute-logo.png", document.currentScript.src).href;
  const hubIcon = L.icon({
    iconUrl: logoUrl,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -17],
    className: "hub-logo-marker",
  });
  const locationIcon = L.divIcon({
    className: "user-location-marker",
    html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true"><path fill="#388e3c" d="M24 2C14.6 2 7 9.6 7 19c0 12.1 17 27 17 27s17-14.9 17-27C41 9.6 33.4 2 24 2z"/><circle cx="24" cy="19" r="6.5" fill="#fff"/></svg>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -17],
  });

  function popupText(text) {
    return String(text).replace(/[&<>\'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[character]));
  }

  function createMap(elementId) {
    return L.map(elementId).setView(defaultCenter, 9);
  }

  function addTiles(map) {
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }

  function addHubLabel(marker, name) {
    return marker.bindTooltip(popupText(name), {
      permanent: true,
      direction: "top",
      offset: [0, -20],
      className: "hub-location-tooltip",
    });
  }

  function moveTo(map, point, zoom, duration) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      map.setView(point, zoom);
      return;
    }
    map.flyTo(point, zoom, { duration });
  }

  function initUserMap(hubs, onPin) {
    if (!userMap) {
      userMap = createMap("userMap");
      addTiles(userMap);
      userMap.on("click", (event) => setUserPin(event.latlng.lat, event.latlng.lng, onPin));
    }
    userHubMarkers.forEach((marker) => marker.remove());
    userHubMarkers = hubs.map((hub) => {
      const marker = L.marker([hub.latitude, hub.longitude], { icon: hubIcon, title: hub.name })
        .addTo(userMap)
        .bindPopup(`Drop-off: ${popupText(hub.name)}`);
      addHubLabel(marker, hub.name);
      marker.on("click", () => setUserPin(hub.latitude, hub.longitude, onPin));
      return marker;
    });
  }

  function setUserPin(latitude, longitude, onPin) {
    const point = [latitude, longitude];
    if (!userPin) {
      userPin = L.marker(point, { draggable: true, icon: locationIcon, title: "Pinned location" })
        .addTo(userMap)
        .bindPopup("Your pinned location")
        .openPopup();
      userPin.on("dragend", (event) => {
        const position = event.target.getLatLng();
        setUserPin(position.lat, position.lng, onPin);
      });
    } else {
      userPin.setLatLng(point);
    }
    moveTo(userMap, point, Math.max(userMap.getZoom(), 14), 0.6);
    onPin(latitude, longitude);
  }

  function centerUserMap() {
    if (!userPin) return false;
    moveTo(userMap, userPin.getLatLng(), 16, 0.6);
    userPin.openPopup();
    return true;
  }

  function clearUserPin() {
    if (!userPin) return;
    userPin.remove();
    userPin = null;
  }

  function initAdminMap(hubs, onPin) {
    if (!hubMap) {
      hubMap = createMap("hubMap");
      addTiles(hubMap);
      hubMap.on("click", (event) => setAdminPin(event.latlng.lat, event.latlng.lng, onPin));
    }
    if (adminPin) adminPin.remove();
    adminPin = null;
    adminHubMarkers.forEach((marker) => marker.remove());
    adminHubMarkers = hubs.map((hub) => {
      const marker = L.marker([hub.latitude, hub.longitude], { icon: hubIcon, title: hub.name })
        .addTo(hubMap)
        .bindPopup(popupText(hub.name));
      addHubLabel(marker, hub.name);
      return marker;
    });
  }

  function showRequestLocation(latitude, longitude, label, hubs) {
    if (!requestMap) {
      requestMap = createMap("requestLocationMap");
      addTiles(requestMap);
    }

    requestHubMarkers.forEach((marker) => marker.remove());
    requestHubMarkers = hubs.map((hub) => {
      const marker = L.marker([hub.latitude, hub.longitude], {
      icon: hubIcon,
      title: hub.name,
      }).addTo(requestMap).bindPopup(`Drop-off: ${popupText(hub.name)}`);
      addHubLabel(marker, hub.name);
      return marker;
    });

    const point = [latitude, longitude];
    if (!requestLocationMarker) {
      requestLocationMarker = L.marker(point, {
        icon: locationIcon,
        title: "E-waste request location",
      }).addTo(requestMap);
    } else {
      requestLocationMarker.setLatLng(point);
    }
    requestLocationMarker.bindPopup(popupText(label)).openPopup();
    requestMap.invalidateSize({ pan: false });
    moveTo(requestMap, point, 15, 0.5);
  }

  function setAdminPin(latitude, longitude, onPin) {
    const point = [latitude, longitude];
    if (!adminPin) {
      adminPin = L.marker(point, { draggable: true, icon: locationIcon, title: "New drop-off location" })
        .addTo(hubMap)
        .bindPopup("New drop-off location");
      adminPin.on("dragend", (event) => {
        const position = event.target.getLatLng();
        setAdminPin(position.lat, position.lng, onPin);
      });
    } else {
      adminPin.setLatLng(point);
    }
    moveTo(hubMap, point, Math.max(hubMap.getZoom(), 14), 0.6);
    onPin(latitude, longitude);
  }

  return {
    initUserMap,
    setUserPin,
    centerUserMap,
    clearUserPin,
    initAdminMap,
    showRequestLocation,
    setAdminPin,
  };
})();
